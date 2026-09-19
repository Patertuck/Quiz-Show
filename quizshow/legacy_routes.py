"""FastAPI transport for the existing services during their domain migration."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse


def _legacy():
    import main

    return main


def _json(status: int, payload=None) -> JSONResponse:
    return JSONResponse(status_code=status, content=payload, headers={"Cache-Control": "no-store"})


def _is_host(request: Request) -> bool:
    if request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for"):
        return False
    client = request.client.host if request.client else ""
    hostname = (request.headers.get("host") or "").split(":", 1)[0].strip("[]").casefold()
    return client in {"127.0.0.1", "::1", "testclient"} and hostname in {"127.0.0.1", "::1", "localhost", "testserver"}


def _require_host(request: Request) -> JSONResponse | None:
    return None if _is_host(request) else _json(403, {"error": "Dieser Endpunkt ist nur auf dem Quiz-Host verfügbar."})


def _require_instance(request: Request) -> JSONResponse | None:
    requested = request.query_params.get("instance")
    if requested is not None and requested == _legacy().QUIZ_LIBRARY.active_instance_name():
        return None
    return _json(409, {"error": "Die aktive Quiz-Instanz wurde gewechselt."})


async def _payload(request: Request, maximum: int) -> dict:
    body = await request.body()
    if not body or len(body) > maximum:
        raise ValueError("Request body is empty or too large.")
    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Request body must be a JSON object.")
    return value


def _role(request: Request, identity_name: str, role_name: str) -> tuple[str, str | int | None]:
    identity: str | int | None = request.query_params.get(identity_name)
    if identity_name == "teamIndex":
        if path == "/api/state" and request.method == "DELETE":
            denied = _require_instance(request)
            if denied:
                return denied
            try:
                legacy.INSTANCE_STATE.clear()
                legacy.BUZZER.sync_teams(None)
                legacy.ORDERING.reset(False)
                legacy.LISTING.reset(False)
                legacy.SYNC.reset(False)
            except (OSError, ValueError) as error:
                return _json(500, {"error": str(error)})
            return _json(200, {"deleted": True})

        try:
            identity = int(identity) if identity is not None else None
        except ValueError:
            identity = None
    if identity is not None:
        return ("team" if identity_name == "teamIndex" else "player"), identity
    requested = request.query_params.get("role")
    return ("public" if requested == "public" or not _is_host(request) else role_name), None


async def _events(request: Request, service, snapshot_args: tuple, *, connect=None, disconnect=None) -> AsyncIterator[bytes]:
    connected = connect() if connect else None
    version = -1
    try:
        while not await request.is_disconnected():
            state = await asyncio.to_thread(service.wait_for_change, version, *snapshot_args)
            if state is None:
                yield b": heartbeat\n\n"
            else:
                version = state["version"]
                encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
                yield f"event: state\nid: {version}\ndata: {encoded}\n\n".encode("utf-8")
    finally:
        if disconnect:
            disconnect(connected)


def _stream(generator: AsyncIterator[bytes]) -> StreamingResponse:
    return StreamingResponse(generator, media_type="text/event-stream", headers={
        "Cache-Control": "no-store", "Connection": "keep-alive",
    })


def install_legacy_routes(app: FastAPI) -> None:
    @app.api_route("/api/{api_path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def api(request: Request, api_path: str):
        legacy = _legacy()
        path = f"/api/{api_path}"
        host_only = {"/api/quiz-library", "/api/quiz-library/control", "/api/final-export", "/api/state"}
        if path in host_only:
            denied = _require_host(request)
            if denied:
                return denied

        if request.method == "GET":
            if path == "/api/team-lobby/state":
                role, device = _role(request, "deviceId", "host")
                return _json(200, legacy.TEAM_LOBBY.snapshot(role, device))
            if path == "/api/team-lobby/events":
                role, device = _role(request, "deviceId", "host")
                return _stream(_events(request, legacy.TEAM_LOBBY, (role, device)))
            if path == "/api/sync/state":
                role, device = _role(request, "deviceId", "host")
                return _json(200, legacy.SYNC.snapshot(role, device))
            if path == "/api/sync/events":
                role, device = _role(request, "deviceId", "host")
                return _stream(_events(
                    request, legacy.SYNC, (role, device),
                    connect=(lambda: legacy.SYNC.connect(device)) if role == "player" else None,
                    disconnect=legacy.SYNC.disconnect if role == "player" else None,
                ))
            if path in {"/api/listing/state", "/api/ordering/state"}:
                role, team = _role(request, "teamIndex", "host")
                service = legacy.LISTING if "listing" in path else legacy.ORDERING
                return _json(200, service.snapshot(role, team))
            if path in {"/api/listing/events", "/api/ordering/events"}:
                role, team = _role(request, "teamIndex", "host")
                service = legacy.LISTING if "listing" in path else legacy.ORDERING
                return _stream(_events(
                    request, service, (role, team),
                    connect=(lambda: service.connect(team)) if role == "team" else None,
                    disconnect=(lambda _connected: service.disconnect(team)) if role == "team" else None,
                ))
            if path == "/api/presentation/state":
                return _json(200, legacy.PRESENTATION.snapshot())
            if path == "/api/presentation/events":
                return _stream(_events(request, legacy.PRESENTATION, ()))
            if path == "/api/buzzer/info":
                return _json(200, legacy.current_join_info())
            if path == "/api/buzzer/state":
                return _json(200, legacy.BUZZER.snapshot())
            if path == "/api/buzzer/events":
                return _stream(_events(request, legacy.BUZZER, ()))
            if path == "/api/quiz-library":
                snapshot = legacy.QUIZ_LIBRARY.snapshot()
                snapshot["activeConfigUrl"] = legacy.QUIZ_LIBRARY.active_config_url()
                return _json(200, snapshot)
            if path == "/api/state":
                denied = _require_instance(request)
                if denied:
                    return denied
                state = legacy.load_current_state()
                return _json(404, {"error": "Es ist kein gespeichertes Spiel vorhanden."}) if state is None else _json(200, state)
            return _json(404, {"error": "Unbekannter API-Endpunkt."})

        try:
            maximum = legacy.MAX_FINAL_EXPORT_BODY_BYTES if path == "/api/final-export" else legacy.MAX_PRESENTATION_BODY_BYTES
            payload = await _payload(request, maximum)
        except (UnicodeError, json.JSONDecodeError, ValueError) as error:
            return _json(400, {"error": str(error)})

        if path not in {"/api/team-lobby/player", "/api/sync/register", "/api/sync/reconnect", "/api/sync/vote",
                        "/api/listing/submission", "/api/ordering/order", "/api/buzzer/buzz"}:
            denied = _require_host(request)
            if denied:
                return denied
        if path not in {"/api/quiz-library/control", "/api/team-lobby/player", "/api/sync/register",
                        "/api/sync/reconnect", "/api/sync/vote", "/api/listing/submission",
                        "/api/ordering/order", "/api/buzzer/buzz"}:
            denied = _require_instance(request)
            if denied:
                return denied

        try:
            if path == "/api/quiz-library/control":
                action = payload.get("action")
                if action == "create":
                    legacy.QUIZ_LIBRARY.create(payload.get("name"), payload.get("variationId"))
                    legacy.bind_active_instance()
                elif action == "activate":
                    previous = legacy.QUIZ_LIBRARY.active_instance_name()
                    legacy.QUIZ_LIBRARY.activate(payload.get("name"))
                    try:
                        legacy.bind_active_instance()
                    except Exception:
                        legacy.QUIZ_LIBRARY.deactivate() if previous is None else legacy.QUIZ_LIBRARY.activate(previous)
                        legacy.bind_active_instance()
                        raise
                elif action == "rename":
                    active = legacy.QUIZ_LIBRARY.active_instance_name() == payload.get("name")
                    legacy.QUIZ_LIBRARY.rename(payload.get("name"), payload.get("newName"))
                    if active:
                        legacy.bind_active_instance()
                elif action == "delete":
                    if legacy.QUIZ_LIBRARY.delete(payload.get("name")):
                        legacy.bind_active_instance()
                else:
                    raise ValueError("Unbekannte Spielstand-Aktion.")
                result = legacy.QUIZ_LIBRARY.snapshot()
                result["activeConfigUrl"] = legacy.QUIZ_LIBRARY.active_config_url()
                return _json(200, result)
            if path == "/api/final-export":
                state = legacy.load_current_state()
                directory = legacy.QUIZ_LIBRARY.active_results_directory()
                if state is None or directory is None:
                    return _json(409, {"error": "Es ist kein gültiger Spielstand für den Export gespeichert."})
                target, created = legacy.save_final_export(payload, state, directory)
                return _json(200, {"saved": True, "created": created,
                                   "directory": str(target.relative_to(legacy.PROJECT_DIRECTORY))})
            if path == "/api/team-lobby/player":
                status, result = legacy.TEAM_LOBBY.player_control(payload)
                return _json(status, result)
            if path in {"/api/team-lobby/initialize", "/api/team-lobby/control"}:
                result = legacy.TEAM_LOBBY.initialize(payload) if path.endswith("initialize") else legacy.TEAM_LOBBY.host_control(payload)
                return _json(200, result)
            if path in {"/api/sync/register", "/api/sync/reconnect", "/api/sync/vote"}:
                method = {"/api/sync/register": legacy.SYNC.register, "/api/sync/reconnect": legacy.SYNC.reconnect,
                          "/api/sync/vote": legacy.SYNC.vote}[path]
                status, result = method(payload)
                return _json(status, result)
            if path == "/api/sync/control":
                result = legacy.SYNC.awards() if payload.get("action") == "awards" else legacy.SYNC.control(payload)
                return _json(200, result)
            if path == "/api/listing/submission":
                status, result = legacy.LISTING.update_submission(payload)
                return _json(status, result)
            if path == "/api/listing/control":
                result = legacy.LISTING.awards() if payload.get("action") == "awards" else legacy.LISTING.control(payload)
                return _json(200, result)
            if path == "/api/ordering/order":
                status, result = legacy.ORDERING.update_order(payload)
                return _json(status, result)
            if path == "/api/ordering/control":
                result = legacy.ORDERING.awards() if payload.get("action") == "awards" else legacy.ORDERING.control(payload)
                return _json(200, result)
            if path == "/api/buzzer/buzz":
                status, result = legacy.BUZZER.buzz(payload)
                return _json(status, result)
            if path == "/api/buzzer/control":
                return _json(200, legacy.BUZZER.control(payload.get("action"), payload.get("questionId"), payload.get("teamIndex")))
            if path == "/api/presentation/state" and request.method == "PUT":
                return _json(200, legacy.PRESENTATION.update(payload))
            if path == "/api/state" and request.method == "PUT":
                state = legacy.validate_state(payload)
                if not legacy.INSTANCE_STATE.write_game(state, state["revision"]):
                    return _json(409, {"error": "Eine neuere Revision des Spielstands ist bereits gespeichert."})
                legacy.BUZZER.sync_teams(state)
                return _json(200, {"saved": True})
        except (UnicodeError, json.JSONDecodeError, ValueError) as error:
            return _json(400, {"error": str(error)})
        except OSError as error:
            return _json(500, {"error": str(error)})
        return _json(404, {"error": "Unbekannter API-Endpunkt."})

    @app.api_route("/{resource_path:path}", methods=["GET", "HEAD"])
    async def static_resource(request: Request, resource_path: str):
        legacy = _legacy()
        url_path = f"/{resource_path}"
        host = _is_host(request)
        if url_path.startswith("/quiz-logos/"):
            file = legacy.QUIZ_LIBRARY.logo_path(url_path)
            return Response(status_code=404) if file is None else FileResponse(file, headers={"Cache-Control": "no-store"})
        if url_path.startswith("/quiz-content/"):
            content = legacy.QUIZ_LIBRARY.content_path(url_path)
            if content is None:
                return Response(status_code=404)
            if content[1] == "config" and not host:
                return _json(403, {"error": "Quizkonfigurationen sind nur auf dem Quiz-Host verfügbar."})
            return FileResponse(content[0], headers={"Cache-Control": "no-cache, max-age=0, must-revalidate"})
        aliases = {"/": "index.html", "/player": "player.html", "/display": "display.html"}
        relative = aliases.get(url_path, resource_path)
        allowed = {
            "player.html", "styles/player.css", "js/player.js", "display.html", "styles/display.css",
            "styles/sync.css", "js/display.js", "js/display-score-animation.js", "js/display-sounds.js",
            "js/score-history-chart.js", "js/fit-text.js", "js/game-catalog.js",
        }
        if not host and relative not in allowed and not relative.startswith("assets/"):
            return _json(403, {"error": "Von einem anderen Gerät sind nur Spieler- und Publikumsansicht verfügbar."})
        root = legacy.PROJECT_DIRECTORY.resolve()
        target = (root / relative).resolve()
        if root not in target.parents or not target.is_file():
            return Response(status_code=404)
        return FileResponse(target, headers={"Cache-Control": "no-cache, max-age=0, must-revalidate"})
