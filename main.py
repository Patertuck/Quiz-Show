"""Launch the quiz show, persist its state, and provide a LAN-only player buzzer."""

from __future__ import annotations

import contextlib
import hashlib
import http.server
import ipaddress
import json
import os
import re
import secrets
import socket
import socketserver
import threading
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit


BIND_HOST = "0.0.0.0"
HOST_URL = "http://127.0.0.1:8000/"
PORT = 8000
PROJECT_DIRECTORY = Path(__file__).resolve().parent
STATE_FILE = PROJECT_DIRECTORY / "game-state.json"
STATE_TEMP_FILE = PROJECT_DIRECTORY / ".game-state.tmp"
MAX_STATE_BYTES = 1_000_000
STATE_LOCK = threading.Lock()
TILE_ID_PATTERN = re.compile(r"^\d+:\d+$")
MAX_BUZZER_BODY_BYTES = 16_384


def find_lan_address() -> str:
    override = os.environ.get("QUIZ_HOST_IP", "").strip()
    if override:
        try:
            address = ipaddress.ip_address(override)
        except ValueError as error:
            raise SystemExit(f"QUIZ_HOST_IP is not a valid IP address: {override}") from error
        if address.version != 4:
            raise SystemExit("QUIZ_HOST_IP must be an IPv4 address.")
        return override
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as probe:
        try:
            probe.connect(("192.0.2.1", 9))
            address = probe.getsockname()[0]
            if not ipaddress.ip_address(address).is_loopback:
                return address
        except OSError:
            pass
    try:
        address = socket.gethostbyname(socket.gethostname())
        if not ipaddress.ip_address(address).is_loopback:
            return address
    except (OSError, ValueError):
        pass
    return "127.0.0.1"


LAN_ADDRESS = find_lan_address()
JOIN_URL = f"http://{LAN_ADDRESS}:{PORT}/buzzer"


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


class BuzzerState:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.version = 0
        self.teams: list[str] = []
        self.teams_revision = ""
        self.round_id: str | None = None
        self.question_id: str | None = None
        self.is_open = False
        self.buzzes: list[int] = []
        self.active_position = 0

    @staticmethod
    def team_revision(teams: list[str]) -> str:
        encoded = json.dumps(teams, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]

    def _changed(self) -> None:
        self.version += 1
        self.condition.notify_all()

    def sync_teams(self, state: dict | None) -> None:
        teams = [team["name"] for team in state.get("teams", [])] if state else []
        revision = self.team_revision(teams)
        with self.condition:
            if revision == self.teams_revision:
                return
            self.teams = teams
            self.teams_revision = revision
            self.round_id = None
            self.question_id = None
            self.is_open = False
            self.buzzes = []
            self.active_position = 0
            self._changed()

    def control(self, action: str, question_id: str | None = None, team_index: int | None = None) -> dict:
        with self.condition:
            if action in {"open", "reset"}:
                if not self.teams:
                    raise ValueError("No teams are available for the buzzer.")
                if not isinstance(question_id, str) or not re.fullmatch(r"\d+:\d+", question_id):
                    raise ValueError("A valid questionId is required.")
                self.round_id = secrets.token_urlsafe(9)
                self.question_id = question_id
                self.is_open = True
                self.buzzes = []
                self.active_position = 0
                self._changed()
            elif action == "close":
                self.is_open = False
                self._changed()
            elif action == "advance":
                active = self.buzzes[self.active_position] if self.active_position < len(self.buzzes) else None
                if active is None or team_index != active:
                    raise ValueError("Only the highlighted team can advance the buzzer queue.")
                self.active_position += 1
                self._changed()
            else:
                raise ValueError("Unknown buzzer control action.")
            return self._snapshot_unlocked()

    def buzz(self, payload: dict) -> tuple[int, dict]:
        round_id = payload.get("roundId")
        teams_revision = payload.get("teamsRevision")
        team_index = payload.get("teamIndex")
        device_id = payload.get("deviceId")
        if not isinstance(device_id, str) or not 8 <= len(device_id) <= 100:
            raise ValueError("A valid deviceId is required.")
        if not isinstance(team_index, int) or isinstance(team_index, bool):
            raise ValueError("teamIndex must be an integer.")
        with self.condition:
            if not self.is_open or round_id != self.round_id:
                return 409, {"error": "Buzzers are closed or the round changed.", "state": self._snapshot_unlocked()}
            if teams_revision != self.teams_revision or not 0 <= team_index < len(self.teams):
                return 409, {"error": "The team list changed. Select your team again.", "state": self._snapshot_unlocked()}
            if team_index in self.buzzes:
                return 409, {"error": "Your team has already buzzed in this round.", "state": self._snapshot_unlocked()}
            self.buzzes.append(team_index)
            position = len(self.buzzes)
            self._changed()
            return 201, {"accepted": True, "position": position, "state": self._snapshot_unlocked()}

    def _snapshot_unlocked(self) -> dict:
        active = self.buzzes[self.active_position] if self.active_position < len(self.buzzes) else None
        return {
            "version": self.version,
            "teams": self.teams,
            "teamsRevision": self.teams_revision,
            "round": {
                "id": self.round_id,
                "questionId": self.question_id,
                "open": self.is_open,
                "buzzes": [{"teamIndex": index, "teamName": self.teams[index]} for index in self.buzzes],
                "activeTeamIndex": active,
            },
        }

    def snapshot(self) -> dict:
        with self.condition:
            return self._snapshot_unlocked()

    def wait_for_change(self, version: int, timeout: float = 15) -> dict | None:
        with self.condition:
            if self.version == version:
                self.condition.wait(timeout)
            return self._snapshot_unlocked() if self.version != version else None


BUZZER = BuzzerState()


def load_current_state() -> dict | None:
    with STATE_LOCK:
        if not STATE_FILE.exists():
            return None
        try:
            return validate_state(json.loads(STATE_FILE.read_text(encoding="utf-8")))
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            return None


class QuizRequestHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_DIRECTORY), **kwargs)

    @property
    def request_path(self) -> str:
        return urlsplit(self.path).path

    @property
    def is_host(self) -> bool:
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def read_json(self, maximum: int = MAX_BUZZER_BODY_BYTES) -> dict:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        if content_length <= 0 or content_length > maximum:
            raise ValueError("Request body is empty or too large.")
        payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        return payload

    def require_host(self) -> bool:
        if self.is_host:
            return True
        self.send_json(403, {"error": "This endpoint is only available on the quiz host."})
        return False

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
        if self.request_path == "/api/buzzer/info":
            self.send_json(200, {"joinUrl": JOIN_URL, "lanAvailable": LAN_ADDRESS != "127.0.0.1"})
            return
        if self.request_path == "/api/buzzer/state":
            self.send_json(200, BUZZER.snapshot())
            return
        if self.request_path == "/api/buzzer/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            version = -1
            try:
                while True:
                    state = BUZZER.wait_for_change(version)
                    if state is None:
                        self.wfile.write(b": heartbeat\n\n")
                    else:
                        version = state["version"]
                        data = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
                        self.wfile.write(f"event: state\nid: {version}\ndata: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            return
        if self.request_path == "/api/state":
            if not self.require_host():
                return
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
        if not self.is_host:
            allowed = {"/buzzer", "/buzzer.html", "/styles/buzzer.css", "/js/buzzer.js"}
            if self.request_path not in allowed:
                self.send_error(403, "Only the buzzer is available from another device.")
                return
        if self.request_path == "/buzzer":
            self.path = "/buzzer.html"
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if not self.is_host and self.request_path not in {"/buzzer", "/buzzer.html", "/styles/buzzer.css", "/js/buzzer.js"}:
            self.send_error(403, "Only the buzzer is available from another device.")
            return
        if self.request_path == "/buzzer":
            self.path = "/buzzer.html"
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path == "/api/buzzer/buzz":
            try:
                status, response = BUZZER.buzz(self.read_json())
            except (UnicodeError, json.JSONDecodeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(status, response)
            return
        if self.request_path == "/api/buzzer/control":
            if not self.require_host():
                return
            try:
                payload = self.read_json()
                response = BUZZER.control(payload.get("action"), payload.get("questionId"), payload.get("teamIndex"))
            except (UnicodeError, json.JSONDecodeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(200, response)
            return
        self.send_json(404, {"error": "Unknown API endpoint."})

    def do_PUT(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path != "/api/state":
            self.send_json(404, {"error": "Unknown API endpoint."})
            return
        if not self.require_host():
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
        BUZZER.sync_teams(state)
        self.send_json(200, {"saved": True})

    def do_DELETE(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path != "/api/state":
            self.send_json(404, {"error": "Unknown API endpoint."})
            return
        if not self.require_host():
            return
        try:
            with STATE_LOCK:
                STATE_FILE.unlink(missing_ok=True)
                STATE_TEMP_FILE.unlink(missing_ok=True)
        except OSError as error:
            self.send_json(500, {"error": f"Could not delete state: {error}"})
            return
        BUZZER.sync_teams(None)
        self.send_json(200, {"deleted": True})


class LocalQuizServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    BUZZER.sync_teams(load_current_state())
    server: LocalQuizServer | None = None
    try:
        with LocalQuizServer((BIND_HOST, PORT), QuizRequestHandler) as server:
            print(f"Quiz show running at {HOST_URL}")
            print(f"Player buzzer available at {JOIN_URL}")
            if LAN_ADDRESS == "127.0.0.1":
                print("Warning: no LAN address was found. Set QUIZ_HOST_IP to this computer's Wi-Fi IPv4 address.")
            print("Press Ctrl+C to stop the server.")
            threading.Timer(0.4, webbrowser.open, args=(HOST_URL,)).start()
            server.serve_forever()
    except OSError as error:
        raise SystemExit(
            f"Could not start the quiz at {HOST_URL}. "
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
