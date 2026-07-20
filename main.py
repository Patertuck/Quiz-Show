"""Launch the quiz show and persist its state on a local-only web server."""

from __future__ import annotations

import contextlib
import http.server
import json
import os
import re
import socketserver
import threading
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit


HOST = "127.0.0.1"
PORT = 8000
PROJECT_DIRECTORY = Path(__file__).resolve().parent
STATE_FILE = PROJECT_DIRECTORY / "game-state.json"
STATE_TEMP_FILE = PROJECT_DIRECTORY / ".game-state.tmp"
MAX_STATE_BYTES = 1_000_000
STATE_LOCK = threading.Lock()
TILE_ID_PATTERN = re.compile(r"^\d+:\d+$")


def validate_state(state: object) -> dict:
    """Validate the stable portion of the browser-to-server state contract."""
    if not isinstance(state, dict):
        raise ValueError("State must be a JSON object.")
    if state.get("version") != 1:
        raise ValueError("Unsupported state version.")
    if not isinstance(state.get("configFingerprint"), str) or not state["configFingerprint"]:
        raise ValueError("configFingerprint must be a non-empty string.")
    if not isinstance(state.get("updatedAt"), str) or not state["updatedAt"]:
        raise ValueError("updatedAt must be a non-empty string.")
    if not isinstance(state.get("gameStarted"), bool):
        raise ValueError("gameStarted must be a boolean.")
    revision = state.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise ValueError("revision must be a positive integer.")

    teams = state.get("teams")
    if not isinstance(teams, list) or not teams:
        raise ValueError("teams must be a non-empty array.")
    for team in teams:
        if not isinstance(team, dict):
            raise ValueError("Each team must be an object.")
        if not isinstance(team.get("name"), str):
            raise ValueError("Each team name must be a string.")
        score = team.get("score")
        if not isinstance(score, int) or isinstance(score, bool):
            raise ValueError("Each team score must be an integer.")

    used_tiles = state.get("usedTiles")
    if not isinstance(used_tiles, list) or any(
        not isinstance(tile, str) or not TILE_ID_PATTERN.fullmatch(tile)
        for tile in used_tiles
    ):
        raise ValueError("usedTiles must contain category:row identifiers.")

    active = state.get("activeQuestion")
    if active is not None:
        if not isinstance(active, dict):
            raise ValueError("activeQuestion must be an object or null.")
        for field in ("categoryIndex", "rowIndex"):
            value = active.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"activeQuestion.{field} must be a non-negative integer.")
        if not isinstance(active.get("answerRevealed"), bool):
            raise ValueError("activeQuestion.answerRevealed must be a boolean.")
    return state


class QuizRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_DIRECTORY), **kwargs)

    @property
    def request_path(self) -> str:
        return urlsplit(self.path).path

    def send_json(self, status: int, payload: object | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        if body:
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path == "/api/state":
            with STATE_LOCK:
                if not STATE_FILE.exists():
                    self.send_json(404, {"error": "No saved game exists."})
                    return
                try:
                    state = validate_state(json.loads(STATE_FILE.read_text(encoding="utf-8")))
                except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
                    self.send_json(500, {"error": f"Saved state is invalid: {error}"})
                    return
            self.send_json(200, state)
            return
        if self.request_path in {"/game-state.json", "/.game-state.tmp"}:
            self.send_error(404)
            return
        super().do_GET()

    def do_PUT(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path != "/api/state":
            self.send_json(404, {"error": "Unknown API endpoint."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid Content-Length header."})
            return
        if content_length <= 0 or content_length > MAX_STATE_BYTES:
            self.send_json(413, {"error": "State body is empty or too large."})
            return

        try:
            state = validate_state(json.loads(self.rfile.read(content_length).decode("utf-8")))
            encoded = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            with STATE_LOCK:
                if STATE_FILE.exists():
                    try:
                        current = validate_state(json.loads(STATE_FILE.read_text(encoding="utf-8")))
                    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                        current = None
                    if (current is not None and current["configFingerprint"] == state["configFingerprint"]
                            and current["revision"] > state["revision"]):
                        self.send_json(409, {"error": "A newer state revision is already saved."})
                        return
                with STATE_TEMP_FILE.open("wb") as state_file:
                    state_file.write(encoded)
                    state_file.flush()
                    os.fsync(state_file.fileno())
                os.replace(STATE_TEMP_FILE, STATE_FILE)
        except (UnicodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json(400, {"error": str(error)})
            return
        except OSError as error:
            self.send_json(500, {"error": f"Could not save state: {error}"})
            return
        self.send_json(200, {"saved": True})

    def do_DELETE(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path != "/api/state":
            self.send_json(404, {"error": "Unknown API endpoint."})
            return
        try:
            with STATE_LOCK:
                STATE_FILE.unlink(missing_ok=True)
                STATE_TEMP_FILE.unlink(missing_ok=True)
        except OSError as error:
            self.send_json(500, {"error": f"Could not delete state: {error}"})
            return
        self.send_json(200, {"deleted": True})


class LocalQuizServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    url = f"http://{HOST}:{PORT}/"
    server: LocalQuizServer | None = None
    try:
        with LocalQuizServer((HOST, PORT), QuizRequestHandler) as server:
            print(f"Quiz show running at {url}")
            print("Press Ctrl+C to stop the server.")
            threading.Timer(0.4, webbrowser.open, args=(url,)).start()
            server.serve_forever()
    except OSError as error:
        raise SystemExit(
            f"Could not start the quiz at {url}. "
            "Another program may already be using port 8000."
        ) from error
    except KeyboardInterrupt:
        print("\nQuiz show stopped.")
    finally:
        if server is not None:
            with contextlib.suppress(Exception):
                server.server_close()


if __name__ == "__main__":
    main()
