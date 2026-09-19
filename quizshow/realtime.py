"""Typed command endpoints and the single live WebSocket transport."""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter, ValidationError

from .container import ApplicationContainer
from .api_models import CommandAccepted, HostCommandEnvelope, PlayerCommandEnvelope
from .domain.commands import Command
from .domain.projections import ClientRole
from .game_services import legacy_game_services
from .session_service import StaleSessionError


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
    snapshots = legacy_game_services().snapshots(role, device_id, team_index)
    session_role = {
        "host": ClientRole.HOST,
        "player": ClientRole.PLAYER,
        "display": ClientRole.DISPLAY,
    }[role]
    legacy = _legacy()
    return {
        "session": container.session.snapshot(session_role),
        "presentation": legacy.PRESENTATION.snapshot(),
        **snapshots,
    }


async def _broadcast(app: FastAPI) -> None:
    container: ApplicationContainer = app.state.container
    await container.connections.broadcast(lambda role, device, team: live_snapshot(container, role, device, team))


async def run_deadline_coordinator(app: FastAPI) -> None:
    """Broadcast once when the nearest server-owned game timer expires."""
    changed: asyncio.Event = app.state.deadline_changed
    while True:
        changed.clear()
        deadline_ms = legacy_game_services().next_deadline_ms()
        if deadline_ms is None:
            await changed.wait()
            continue
        delay = max(0.0, deadline_ms / 1000 - time.time())
        try:
            await asyncio.wait_for(changed.wait(), timeout=delay)
        except TimeoutError:
            await _broadcast(app)


def install_realtime(app: FastAPI) -> None:
    @app.middleware("http")
    async def publish_mutations(request: Request, call_next):
        response = await call_next(request)
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.url.path.startswith("/api/"):
            if response.status_code < 500:
                await _broadcast(request.app)
                request.app.state.deadline_changed.set()
        return response

    @app.post("/api/host/commands", response_model=CommandAccepted)
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
        return CommandAccepted(revision=updated.revision)

    @app.post("/api/player/commands")
    async def player_command(request: Request, envelope: PlayerCommandEnvelope):
        try:
            status, result = legacy_game_services().execute_player(envelope.type, envelope.payload)
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
