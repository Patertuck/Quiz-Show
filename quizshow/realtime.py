"""Typed command endpoints and the single live WebSocket transport."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from .container import ApplicationContainer
from .domain.commands import Command
from .domain.projections import ClientRole
from .session_service import StaleSessionError


class HostCommandEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    instance_name: str = Field(alias="instanceName", min_length=1)
    expected_revision: int = Field(alias="expectedRevision", ge=0)
    command: dict[str, Any]


class PlayerCommandEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal[
        "team-lobby", "buzz", "ordering", "listing", "sync-register", "sync-reconnect", "sync-vote"
    ]
    payload: dict[str, Any]


COMMAND_ADAPTER = TypeAdapter(Command)


def _legacy():
    import main

    return main


def _host_scope(headers, client_host: str) -> bool:
    if headers.get("cf-connecting-ip") or headers.get("x-forwarded-for"):
        return False
    hostname = (headers.get("host") or "").split(":", 1)[0].strip("[]").casefold()
    return client_host in {"127.0.0.1", "::1", "testclient"} and hostname in {
        "127.0.0.1", "::1", "localhost", "testserver",
    }


def live_snapshot(container: ApplicationContainer, role: str, device_id: str | None,
                  team_index: int | None) -> dict:
    legacy = _legacy()
    if role == "host":
        lobby = legacy.TEAM_LOBBY.snapshot("host", None)
        ordering = legacy.ORDERING.snapshot("host", None)
        listing = legacy.LISTING.snapshot("host", None)
        sync = legacy.SYNC.snapshot("host", None)
        session_role = ClientRole.HOST
    elif role == "player":
        lobby = legacy.TEAM_LOBBY.snapshot("player", device_id) if device_id else legacy.TEAM_LOBBY.snapshot()
        ordering = legacy.ORDERING.snapshot("team", team_index) if team_index is not None else legacy.ORDERING.snapshot("public", None)
        listing = legacy.LISTING.snapshot("team", team_index) if team_index is not None else legacy.LISTING.snapshot("public", None)
        sync = legacy.SYNC.snapshot("player", device_id) if device_id else legacy.SYNC.snapshot("public", None)
        session_role = ClientRole.PLAYER
    else:
        lobby = legacy.TEAM_LOBBY.snapshot("public", None)
        ordering = legacy.ORDERING.snapshot("public", None)
        listing = legacy.LISTING.snapshot("public", None)
        sync = legacy.SYNC.snapshot("public", None)
        session_role = ClientRole.DISPLAY
    return {
        "session": container.session.snapshot(session_role),
        "presentation": legacy.PRESENTATION.snapshot(),
        "teamLobby": lobby,
        "buzzer": legacy.BUZZER.snapshot(),
        "ordering": ordering,
        "listing": listing,
        "sync": sync,
    }


async def _broadcast(app: FastAPI) -> None:
    container: ApplicationContainer = app.state.container
    await container.connections.broadcast(lambda role, device, team: live_snapshot(container, role, device, team))


def install_realtime(app: FastAPI) -> None:
    @app.middleware("http")
    async def publish_mutations(request: Request, call_next):
        response = await call_next(request)
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.url.path.startswith("/api/"):
            if response.status_code < 500:
                await _broadcast(request.app)
        return response

    @app.post("/api/host/commands")
    async def host_command(request: Request, envelope: HostCommandEnvelope):
        client = request.client.host if request.client else ""
        if not _host_scope(request.headers, client):
            return JSONResponse({"error": "Dieser Endpunkt ist nur auf dem Quiz-Host verfügbar."}, status_code=403)
        container: ApplicationContainer = request.app.state.container
        try:
            command = COMMAND_ADAPTER.validate_python(envelope.command)
            updated = container.session.execute(
                command,
                instance_name=envelope.instance_name,
                expected_revision=envelope.expected_revision,
            )
        except ValidationError as error:
            return JSONResponse({"error": "Ungültiger Befehl.", "details": error.errors(include_url=False)}, status_code=422)
        except StaleSessionError as error:
            return JSONResponse({"error": str(error)}, status_code=409)
        except (ValueError, OSError) as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        return {"accepted": True, "revision": updated.revision}

    @app.post("/api/player/commands")
    async def player_command(request: Request, envelope: PlayerCommandEnvelope):
        legacy = _legacy()
        try:
            if envelope.type == "team-lobby":
                status, result = legacy.TEAM_LOBBY.player_control(envelope.payload)
            elif envelope.type == "buzz":
                status, result = legacy.BUZZER.buzz(envelope.payload)
            elif envelope.type == "ordering":
                status, result = legacy.ORDERING.update_order(envelope.payload)
            elif envelope.type == "listing":
                status, result = legacy.LISTING.update_submission(envelope.payload)
            else:
                operation = {
                    "sync-register": legacy.SYNC.register,
                    "sync-reconnect": legacy.SYNC.reconnect,
                    "sync-vote": legacy.SYNC.vote,
                }[envelope.type]
                status, result = operation(envelope.payload)
        except (ValueError, OSError) as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        return JSONResponse(result, status_code=status)

    @app.websocket("/ws/live")
    async def live(websocket: WebSocket):
        role = websocket.query_params.get("role", "display")
        if role not in {"host", "player", "display"}:
            await websocket.close(code=1008)
            return
        client_host = websocket.client.host if websocket.client else ""
        if role == "host" and not _host_scope(websocket.headers, client_host):
            await websocket.close(code=1008)
            return
        device_id = websocket.query_params.get("deviceId") if role == "player" else None
        try:
            team_index = int(websocket.query_params.get("teamIndex", "")) if role == "player" else None
        except ValueError:
            team_index = None
        connection_id = uuid.uuid4().hex
        container: ApplicationContainer = websocket.app.state.container
        await websocket.accept()
        await container.connections.add(
            connection_id, websocket, role=role, device_id=device_id, team_index=team_index,
        )
        await websocket.send_json({"type": "snapshot", "data": live_snapshot(
            container, role, device_id, team_index,
        )})
        try:
            while True:
                message = await websocket.receive_json()
                if message.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        finally:
            await container.connections.remove(connection_id)
