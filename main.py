"""Launch the quiz show with local/LAN access and optional public sharing."""

from __future__ import annotations

import contextlib
import argparse
import hashlib
import http.server
import ipaddress
import json
import os
import re
import random
import secrets
import socket
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from listing_game import GroqClassifier, ListingState
from sync_game import SyncState


BIND_HOST = "0.0.0.0"
HOST_URL = "http://127.0.0.1:8000/"
PORT = 8000
PROJECT_DIRECTORY = Path(__file__).resolve().parent
STATE_FILE = PROJECT_DIRECTORY / "game-state.json"
STATE_TEMP_FILE = PROJECT_DIRECTORY / ".game-state.tmp"
ORDERING_FILE = PROJECT_DIRECTORY / "ordering-state.json"
ORDERING_TEMP_FILE = PROJECT_DIRECTORY / ".ordering-state.tmp"
LISTING_FILE = PROJECT_DIRECTORY / "listing-state.json"
SYNC_FILE = PROJECT_DIRECTORY / "sync-state.json"
SERVER_CONFIG_FILE = PROJECT_DIRECTORY / "server-config.json"
MAX_STATE_BYTES = 1_000_000
STATE_LOCK = threading.Lock()
TILE_ID_PATTERN = re.compile(r"^\d+:\d+$")
MAX_BUZZER_BODY_BYTES = 16_384
MAX_PRESENTATION_BODY_BYTES = 262_144
PRESENTATION_SCREENS = {"standby", "intro", "team-lobby", "warmup-question", "hub", "jeopardy-board", "jeopardy-question", "ordering", "listing", "sync", "victory"}
HUB_GAME_IDS = {"jeopardy", "ordering", "listing", "sync"}
QUICK_TUNNEL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)
PUBLIC_URL_LOCK = threading.Lock()
PUBLIC_BASE_URL: str | None = None


def set_public_base_url(url: str | None) -> None:
    """Publish or clear the temporary external origin used by join links."""
    global PUBLIC_BASE_URL
    with PUBLIC_URL_LOCK:
        PUBLIC_BASE_URL = url.rstrip("/") if url else None


def get_public_base_url() -> str | None:
    with PUBLIC_URL_LOCK:
        return PUBLIC_BASE_URL


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
JOIN_URL = f"http://{LAN_ADDRESS}:{PORT}/player"


def current_join_info() -> dict:
    """Re-evaluate the address after a Wi-Fi or hotspot change."""
    address = find_lan_address()
    public_base = get_public_base_url()
    base = public_base or f"http://{address}:{PORT}"
    return {
        "mode": "public" if public_base else "local",
        "joinUrl": f"{base}/player",
        "displayUrl": f"{base}/display",
        "localUrl": f"http://127.0.0.1:{PORT}/player",
        "localDisplayUrl": f"http://127.0.0.1:{PORT}/display",
        "lanAvailable": address != "127.0.0.1",
    }


class QuickTunnel:
    """Manage a Cloudflare Quick Tunnel without making it part of local mode."""

    def __init__(self, executable: str = "cloudflared") -> None:
        self.executable = executable
        self.process: subprocess.Popen[str] | None = None
        self.url: str | None = None
        self._url_ready = threading.Event()
        self._reader: threading.Thread | None = None

    def start(self, timeout: float = 30.0) -> str:
        command = [
            self.executable, "tunnel", "--url", f"http://127.0.0.1:{PORT}",
            "--no-autoupdate",
        ]
        try:
            self.process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except FileNotFoundError as error:
            raise RuntimeError(
                "cloudflared was not found. Install it with "
                "'winget install --id Cloudflare.cloudflared' and try again."
            ) from error
        except OSError as error:
            raise RuntimeError(f"cloudflared could not be started: {error}") from error

        self._reader = threading.Thread(target=self._read_output, name="cloudflared-output", daemon=True)
        self._reader.start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._url_ready.wait(0.1):
                if self.process.poll() is not None:
                    break
                return self.url  # type: ignore[return-value]
            if self.process.poll() is not None:
                break
        self.stop()
        raise RuntimeError(
            "Cloudflare did not provide a public URL. Check the internet connection and try again."
        )

    def _read_output(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        for line in self.process.stdout:
            clean = line.rstrip()
            if clean:
                print(f"[cloudflared] {clean}")
            match = QUICK_TUNNEL_PATTERN.search(line)
            if match and self.url is None:
                self.url = match.group(0).rstrip("/")
                self._url_ready.set()
        if self.url:
            clear_public_base_url(self.url)
            print("Public tunnel stopped; the quiz is still available locally.")

    def stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def clear_public_base_url(expected_url: str) -> None:
    """Clear a tunnel URL only if it is still the active tunnel."""
    with PUBLIC_URL_LOCK:
        global PUBLIC_BASE_URL
        if PUBLIC_BASE_URL == expected_url.rstrip("/"):
            PUBLIC_BASE_URL = None


def validate_state(state: object) -> dict:
    """Validate the stable portion of the browser-to-server state contract."""
    if not isinstance(state, dict):
        raise ValueError("State must be a JSON object.")
    if state.get("version") not in {1, 2}:
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
    if state["version"] == 1:
        state = {**state, "version": 2, "appliedAwards": []}
    awards = state.get("appliedAwards")
    if not isinstance(awards, list) or any(not isinstance(item, str) or not item for item in awards):
        raise ValueError("appliedAwards must contain non-empty strings.")
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
            self._changed()

    def control(self, action: str, question_id: str | None = None, team_index: int | None = None) -> dict:
        with self.condition:
            if action in {"open", "reset"}:
                if not self.teams:
                    raise ValueError("Für den Buzzer sind keine Teams verfügbar.")
                if not isinstance(question_id, str) or not re.fullmatch(r"\d+:\d+", question_id):
                    raise ValueError("Eine gültige questionId ist erforderlich.")
                self.round_id = secrets.token_urlsafe(9)
                self.question_id = question_id
                self.is_open = True
                self.buzzes = []
                self._changed()
            elif action == "close":
                self.is_open = False
                self._changed()
            elif action == "remove":
                if not self.is_open or question_id != self.question_id:
                    raise ValueError("Die Buzzer-Runde ist nicht mehr aktuell.")
                if not isinstance(team_index, int) or isinstance(team_index, bool) or not 0 <= team_index < len(self.teams):
                    raise ValueError("Ein gültiger teamIndex ist erforderlich.")
                if team_index in self.buzzes:
                    self.buzzes.remove(team_index)
                    self._changed()
            else:
                raise ValueError("Unbekannte Buzzer-Aktion.")
            return self._snapshot_unlocked()

    def buzz(self, payload: dict) -> tuple[int, dict]:
        round_id = payload.get("roundId")
        teams_revision = payload.get("teamsRevision")
        team_index = payload.get("teamIndex")
        device_id = payload.get("deviceId")
        if not isinstance(device_id, str) or not 8 <= len(device_id) <= 100:
            raise ValueError("Eine gültige deviceId ist erforderlich.")
        if not isinstance(team_index, int) or isinstance(team_index, bool):
            raise ValueError("teamIndex muss eine Ganzzahl sein.")
        with self.condition:
            if not self.is_open or round_id != self.round_id:
                return 409, {"error": "Die Buzzer sind geschlossen oder die Runde wurde gewechselt.", "state": self._snapshot_unlocked()}
            if teams_revision != self.teams_revision or not 0 <= team_index < len(self.teams):
                return 409, {"error": "Die Teamliste wurde geändert. Wählt euer Team erneut.", "state": self._snapshot_unlocked()}
            if team_index in self.buzzes:
                return 409, {"error": "Euer Team hat in dieser Runde bereits gebuzzert.", "state": self._snapshot_unlocked()}
            self.buzzes.append(team_index)
            position = len(self.buzzes)
            self._changed()
            return 201, {"accepted": True, "position": position, "state": self._snapshot_unlocked()}

    def _snapshot_unlocked(self) -> dict:
        active = self.buzzes[0] if self.buzzes else None
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


class TeamLobbyState:
    MAX_TEAMS = 12
    MAX_NAME_LENGTH = 40

    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.version = 0
        self.config_fingerprint = ""
        self.phase = "uninitialized"
        self.teams: list[dict] = []
        self.memberships: dict[str, str] = {}

    @staticmethod
    def _device_id(value: object) -> str:
        if not isinstance(value, str) or not 8 <= len(value) <= 100:
            raise ValueError("Eine gültige deviceId ist erforderlich.")
        return value

    def _name(self, value: object, excluding_id: str | None = None) -> str:
        if not isinstance(value, str):
            raise ValueError("Der Teamname muss eine Zeichenfolge sein.")
        name = " ".join(value.split())
        if not name or len(name) > self.MAX_NAME_LENGTH:
            raise ValueError(f"Teamnamen müssen 1 bis {self.MAX_NAME_LENGTH} Zeichen lang sein.")
        if any(team["id"] != excluding_id and team["name"].casefold() == name.casefold() for team in self.teams):
            raise ValueError("Dieser Teamname wird bereits verwendet.")
        return name

    def _changed(self) -> None:
        self.version += 1
        self.condition.notify_all()

    def _team(self, team_id: object) -> dict:
        if not isinstance(team_id, str):
            raise ValueError("Eine gültige teamId ist erforderlich.")
        team = next((item for item in self.teams if item["id"] == team_id), None)
        if team is None:
            raise ValueError("Dieses Team existiert nicht mehr.")
        return team

    def initialize(self, payload: dict) -> dict:
        fingerprint = payload.get("configFingerprint")
        source = payload.get("teams")
        if not isinstance(fingerprint, str) or not fingerprint or not isinstance(source, list):
            raise ValueError("Die Team-Lobby kann nicht initialisiert werden.")
        if not 1 <= len(source) <= self.MAX_TEAMS:
            raise ValueError(f"Die Lobby benötigt 1 bis {self.MAX_TEAMS} Teams.")
        with self.condition:
            if self.phase in {"open", "locked"} and self.config_fingerprint == fingerprint and not payload.get("force"):
                return self._snapshot_unlocked("host")
            self.teams = []
            self.memberships = {}
            for item in source:
                if not isinstance(item, dict):
                    raise ValueError("Jedes Lobby-Team muss ein Objekt sein.")
                name = self._name(item.get("name"))
                current_score = item.get("currentScore", 0)
                starting_score = item.get("startingScore", 0)
                if (not isinstance(current_score, int) or isinstance(current_score, bool)
                        or not isinstance(starting_score, int) or isinstance(starting_score, bool)):
                    raise ValueError("Teampunkte müssen Ganzzahlen sein.")
                self.teams.append({
                    "id": secrets.token_urlsafe(8), "name": name, "ownerDeviceId": None,
                    "currentScore": current_score, "startingScore": starting_score,
                })
            self.config_fingerprint = fingerprint
            self.phase = "open"
            self._changed()
            return self._snapshot_unlocked("host")

    def host_control(self, payload: dict) -> dict:
        action = payload.get("action")
        with self.condition:
            if action == "unlock":
                self.phase = "open"
                self._changed()
                return self._snapshot_unlocked("host")
            if self.phase != "open":
                raise ValueError("Die Team-Lobby ist geschlossen.")
            if action == "add":
                if len(self.teams) >= self.MAX_TEAMS:
                    raise ValueError(f"Es sind höchstens {self.MAX_TEAMS} Teams erlaubt.")
                self.teams.append({
                    "id": secrets.token_urlsafe(8), "name": self._name(payload.get("name")),
                    "ownerDeviceId": None, "currentScore": 0, "startingScore": 0,
                })
            elif action == "rename":
                team = self._team(payload.get("teamId"))
                team["name"] = self._name(payload.get("name"), team["id"])
            elif action == "remove":
                team = self._team(payload.get("teamId"))
                self.teams.remove(team)
                self.memberships = {device: selected for device, selected in self.memberships.items() if selected != team["id"]}
            elif action == "lock":
                if not self.teams:
                    raise ValueError("Erstellt mindestens ein Team, bevor das Spiel beginnt.")
                self.phase = "locked"
            else:
                raise ValueError("Unbekannte Team-Lobby-Aktion.")
            self._changed()
            return self._snapshot_unlocked("host")

    def player_control(self, payload: dict) -> tuple[int, dict]:
        device_id = self._device_id(payload.get("deviceId"))
        action = payload.get("action")
        with self.condition:
            if self.phase != "open":
                return 409, {"error": "Die Team-Lobby ist geschlossen.", "state": self._snapshot_unlocked("player", device_id)}
            if action == "join":
                team = self._team(payload.get("teamId"))
                self.memberships[device_id] = team["id"]
            elif action == "create":
                if len(self.teams) >= self.MAX_TEAMS:
                    raise ValueError(f"Es sind höchstens {self.MAX_TEAMS} Teams erlaubt.")
                if any(team["ownerDeviceId"] == device_id for team in self.teams):
                    raise ValueError("Dieses Gerät hat bereits ein Team erstellt.")
                team = {
                    "id": secrets.token_urlsafe(8), "name": self._name(payload.get("name")),
                    "ownerDeviceId": device_id, "currentScore": 0, "startingScore": 0,
                }
                self.teams.append(team)
                self.memberships[device_id] = team["id"]
            else:
                raise ValueError("Unbekannte Team-Lobby-Aktion.")
            self._changed()
            return 200, self._snapshot_unlocked("player", device_id)

    def _snapshot_unlocked(self, role: str = "public", device_id: str | None = None) -> dict:
        member_counts: dict[str, int] = {}
        for team_id in self.memberships.values():
            member_counts[team_id] = member_counts.get(team_id, 0) + 1
        teams = []
        for team in self.teams:
            item = {"id": team["id"], "name": team["name"], "memberCount": member_counts.get(team["id"], 0)}
            if role == "host":
                item.update({"currentScore": team["currentScore"], "startingScore": team["startingScore"]})
            teams.append(item)
        snapshot = {"version": self.version, "phase": self.phase, "maxTeams": self.MAX_TEAMS, "teams": teams}
        if role == "player" and device_id:
            snapshot["selectedTeamId"] = self.memberships.get(device_id)
            snapshot["ownedTeamId"] = next((team["id"] for team in self.teams if team["ownerDeviceId"] == device_id), None)
        return snapshot

    def snapshot(self, role: str = "public", device_id: str | None = None) -> dict:
        with self.condition:
            return self._snapshot_unlocked(role, device_id)

    def wait_for_change(self, version: int, role: str = "public", device_id: str | None = None,
                        timeout: float = 15) -> dict | None:
        with self.condition:
            if self.version == version:
                self.condition.wait(timeout)
            return self._snapshot_unlocked(role, device_id) if self.version != version else None


TEAM_LOBBY = TeamLobbyState()


class OrderingState:
    """Persistent, server-authoritative state for collaborative ordering rounds."""

    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.version = 0
        self.config_fingerprint = ""
        self.teams: list[str] = []
        self.teams_revision = ""
        self.completed: list[str] = []
        self.round: dict | None = None
        self.connections: dict[int, int] = {}
        self.poll_connections: dict[str, tuple[int, float]] = {}
        self._load()

    def _load(self) -> None:
        if not ORDERING_FILE.exists():
            return
        try:
            data = json.loads(ORDERING_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1:
                return
            self.config_fingerprint = data.get("configFingerprint", "")
            self.teams = data.get("teams", [])
            self.teams_revision = BuzzerState.team_revision(self.teams)
            self.completed = data.get("completedQuestionIds", [])
            self.round = data.get("round")
        except (OSError, UnicodeError, json.JSONDecodeError):
            self.round = None

    def _save_unlocked(self) -> None:
        data = {
            "version": 1, "configFingerprint": self.config_fingerprint,
            "teams": self.teams, "completedQuestionIds": self.completed, "round": self.round,
        }
        encoded = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        with ORDERING_TEMP_FILE.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(ORDERING_TEMP_FILE, ORDERING_FILE)

    def _changed_unlocked(self, persist: bool = True) -> None:
        if persist:
            self._save_unlocked()
        self.version += 1
        self.condition.notify_all()

    def _expire_unlocked(self) -> None:
        if self.round and self.round.get("phase") == "active" and int(time.time() * 1000) >= self.round["deadlineAt"]:
            self.round["phase"] = "locked"
            self._changed_unlocked()

    def reset(self) -> None:
        with self.condition:
            self.config_fingerprint = ""
            self.teams = []
            self.teams_revision = ""
            self.completed = []
            self.round = None
            self.poll_connections = {}
            ORDERING_FILE.unlink(missing_ok=True)
            ORDERING_TEMP_FILE.unlink(missing_ok=True)
            self._changed_unlocked(False)

    def configure(self, fingerprint: str, teams: list[str], question_ids: list[str]) -> None:
        if not fingerprint or not teams or not question_ids:
            raise ValueError("Konfiguration, Teams und Fragen für Order Up sind erforderlich.")
        revision = BuzzerState.team_revision(teams)
        with self.condition:
            if fingerprint != self.config_fingerprint or revision != self.teams_revision:
                self.completed = []
                self.round = None
                self.poll_connections = {}
            self.config_fingerprint = fingerprint
            self.teams = list(teams)
            self.teams_revision = revision
            self.completed = [item for item in self.completed if item in question_ids]
            self._changed_unlocked()

    @staticmethod
    def _validate_question(question: object) -> dict:
        if not isinstance(question, dict):
            raise ValueError("Eine Frage ist erforderlich.")
        for field in ("id", "title", "prompt"):
            if not isinstance(question.get(field), str) or not question[field].strip():
                raise ValueError(f"Das Fragenfeld {field} ist erforderlich.")
        items = question.get("items")
        seconds = question.get("timeLimitSeconds")
        points = question.get("pointsPerCorrect")
        if not isinstance(items, list) or not 3 <= len(items) <= 7 or any(not isinstance(item, str) or not item.strip() for item in items):
            raise ValueError("Eine Frage benötigt 3 bis 7 Elemente.")
        if len({item.strip().casefold() for item in items}) != len(items):
            raise ValueError("Die Elemente einer Frage müssen eindeutig sein.")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or not 5 <= seconds <= 600:
            raise ValueError("timeLimitSeconds muss zwischen 5 und 600 liegen.")
        if not isinstance(points, int) or isinstance(points, bool) or points <= 0:
            raise ValueError("pointsPerCorrect muss positiv sein.")
        return question

    def start(self, question: object) -> None:
        clean = self._validate_question(question)
        with self.condition:
            self._expire_unlocked()
            if not self.teams:
                raise ValueError("Richtet die Teams ein, bevor ihr eine Order-Up-Runde startet.")
            if self.round and self.round.get("phase") != "distributed":
                raise ValueError("Beendet oder brecht zuerst die aktuelle Order-Up-Runde ab.")
            if clean["id"] in self.completed:
                raise ValueError("Diese Order-Up-Frage wurde bereits abgeschlossen.")
            correct = [{"id": f"item-{index}", "text": text} for index, text in enumerate(clean["items"])]
            shuffled = [item.copy() for item in correct]
            random.SystemRandom().shuffle(shuffled)
            if [item["id"] for item in shuffled] == [item["id"] for item in correct]:
                shuffled = shuffled[1:] + shuffled[:1]
            order = [item["id"] for item in shuffled]
            self.round = {
                "id": secrets.token_urlsafe(12), "questionId": clean["id"], "title": clean["title"],
                "prompt": clean["prompt"], "timeLimitSeconds": clean["timeLimitSeconds"],
                "pointsPerCorrect": clean["pointsPerCorrect"], "correctItems": correct,
                "shuffledItems": shuffled, "teamOrders": [order.copy() for _ in self.teams],
                "deadlineAt": int(time.time() * 1000) + clean["timeLimitSeconds"] * 1000,
                "phase": "active", "revealed": [],
            }
            self._changed_unlocked()

    def update_order(self, payload: dict) -> tuple[int, dict]:
        team_index = payload.get("teamIndex")
        order = payload.get("order")
        with self.condition:
            self._expire_unlocked()
            if not self.round or self.round["phase"] != "active" or payload.get("roundId") != self.round["id"]:
                return 409, {"error": "Die Zeit ist abgelaufen oder die Runde wurde gewechselt.", "state": self._snapshot_unlocked("team", team_index)}
            if payload.get("teamsRevision") != self.teams_revision or not isinstance(team_index, int) or isinstance(team_index, bool) or not 0 <= team_index < len(self.teams):
                return 409, {"error": "Die Teamliste wurde geändert. Wählt euer Team erneut.", "state": self._snapshot_unlocked("public")}
            expected = {item["id"] for item in self.round["shuffledItems"]}
            if not isinstance(order, list) or len(order) != len(expected) or set(order) != expected:
                raise ValueError("order muss jedes Element genau einmal enthalten.")
            self.round["teamOrders"][team_index] = list(order)
            self._changed_unlocked()
            return 200, {"saved": True, "state": self._snapshot_unlocked("team", team_index)}

    def control(self, payload: dict) -> dict:
        action = payload.get("action")
        if action == "configure":
            teams = payload.get("teams")
            ids = payload.get("questionIds")
            if not isinstance(teams, list) or any(not isinstance(x, str) for x in teams) or not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
                raise ValueError("Ungültige Order-Up-Konfiguration.")
            self.configure(payload.get("configFingerprint", ""), teams, ids)
        elif action == "start":
            self.start(payload.get("question"))
        else:
            with self.condition:
                self._expire_unlocked()
                if not self.round:
                    raise ValueError("Es gibt keine aktuelle Order-Up-Runde.")
                if action == "lock":
                    if self.round["phase"] != "active":
                        raise ValueError("Die Runde ist bereits gesperrt.")
                    self.round["phase"] = "locked"
                elif action == "cancel":
                    if self.round["revealed"]:
                        raise ValueError("Eine Runde kann nicht abgebrochen werden, nachdem das Aufdecken begonnen hat.")
                    self.round = None
                elif action == "reveal":
                    slot = payload.get("slot")
                    if self.round["phase"] == "active":
                        raise ValueError("Sperrt die Antworten, bevor ihr sie aufdeckt.")
                    if not isinstance(slot, int) or isinstance(slot, bool) or not 0 <= slot < len(self.round["correctItems"]):
                        raise ValueError("Ungültige Antwortposition.")
                    if slot not in self.round["revealed"]:
                        self.round["revealed"].append(slot)
                        self.round["revealed"].sort()
                elif action == "confirm-distribution":
                    if len(self.round["revealed"]) != len(self.round["correctItems"]):
                        raise ValueError("Deckt alle Antworten auf, bevor ihr die Punkte verteilt.")
                    self.round["phase"] = "distributed"
                    if self.round["questionId"] not in self.completed:
                        self.completed.append(self.round["questionId"])
                elif action == "close":
                    if self.round["phase"] != "distributed":
                        raise ValueError("Verteilt die Punkte, bevor ihr die Runde schliesst.")
                    self.round = None
                else:
                    raise ValueError("Unbekannte Order-Up-Aktion.")
                self._changed_unlocked()
        return self.snapshot("host")

    def _round_points_unlocked(self, team_index: int) -> int:
        if not self.round:
            return 0
        correct = [item["id"] for item in self.round["correctItems"]]
        order = self.round["teamOrders"][team_index]
        return sum(self.round["pointsPerCorrect"] for slot in self.round["revealed"] if order[slot] == correct[slot])

    def awards(self) -> dict:
        with self.condition:
            self._expire_unlocked()
            if not self.round or len(self.round["revealed"]) != len(self.round["correctItems"]):
                raise ValueError("Deckt alle Antworten auf, bevor ihr die Punkte verteilt.")
            return {
                "awardId": f"ordering:{self.round['id']}",
                "awards": [{"teamIndex": index, "points": self._round_points_unlocked(index)} for index in range(len(self.teams))],
            }

    def _snapshot_unlocked(self, role: str, team_index: int | None = None) -> dict:
        self._expire_unlocked()
        self._prune_poll_connections_unlocked()
        connected_teams = set(self.connections)
        connected_teams.update(team for team, _expires in self.poll_connections.values())
        result = {
            "version": self.version, "teams": self.teams, "teamsRevision": self.teams_revision,
            "completedQuestionIds": self.completed, "connectedTeamCount": len(connected_teams), "round": None,
        }
        if not self.round:
            return result
        round_data = {key: self.round[key] for key in (
            "id", "questionId", "title", "prompt", "timeLimitSeconds", "pointsPerCorrect",
            "shuffledItems", "deadlineAt", "phase", "revealed"
        )}
        if role == "host":
            round_data["correctItems"] = self.round["correctItems"]
            round_data["teamOrders"] = self.round["teamOrders"]
            round_data["roundPoints"] = [self._round_points_unlocked(index) for index in range(len(self.teams))]
        elif role == "team":
            if isinstance(team_index, int) and 0 <= team_index < len(self.teams) and self.round["phase"] == "active":
                round_data["teamOrder"] = self.round["teamOrders"][team_index]
        elif self.round["phase"] != "active":
            round_data["teamOrders"] = self.round["teamOrders"]
            round_data["revealedItems"] = [
                self.round["correctItems"][slot] if slot in self.round["revealed"] else None
                for slot in range(len(self.round["correctItems"]))
            ]
            round_data["roundPoints"] = [self._round_points_unlocked(index) for index in range(len(self.teams))]
        result["round"] = round_data
        return result

    def snapshot(self, role: str = "public", team_index: int | None = None) -> dict:
        with self.condition:
            return self._snapshot_unlocked(role, team_index)

    def wait_for_change(self, version: int, role: str, team_index: int | None, timeout: float = 15) -> dict | None:
        with self.condition:
            self._expire_unlocked()
            wait = timeout
            if self.round and self.round["phase"] == "active":
                wait = min(wait, max(0.05, (self.round["deadlineAt"] - int(time.time() * 1000)) / 1000))
            if self.poll_connections:
                next_expiry = min(expires_at for _, expires_at in self.poll_connections.values())
                wait = min(wait, max(0.05, next_expiry - time.monotonic()))
            if self.version == version:
                self.condition.wait(wait)
            self._prune_poll_connections_unlocked()
            self._expire_unlocked()
            return self._snapshot_unlocked(role, team_index) if self.version != version else None

    def connect(self, team_index: int) -> None:
        with self.condition:
            if 0 <= team_index < len(self.teams):
                self.connections[team_index] = self.connections.get(team_index, 0) + 1
                self._changed_unlocked(False)

    def _prune_poll_connections_unlocked(self) -> None:
        now = time.monotonic()
        expired = [client_id for client_id, (_team, expires) in self.poll_connections.items() if expires <= now]
        if expired:
            for client_id in expired:
                del self.poll_connections[client_id]
            self._changed_unlocked(False)

    def touch_poll_connection(self, client_id: str, team_index: int, ttl: float = 10.0) -> None:
        with self.condition:
            if not client_id or not 0 <= team_index < len(self.teams):
                return
            self._prune_poll_connections_unlocked()
            previous = self.poll_connections.get(client_id)
            self.poll_connections[client_id] = (team_index, time.monotonic() + ttl)
            if previous is None or previous[0] != team_index:
                self._changed_unlocked(False)

    def disconnect(self, team_index: int) -> None:
        with self.condition:
            if team_index in self.connections:
                self.connections[team_index] -= 1
                if self.connections[team_index] <= 0:
                    del self.connections[team_index]
                self._changed_unlocked(False)


ORDERING = OrderingState()
LISTING = ListingState(LISTING_FILE, GroqClassifier(SERVER_CONFIG_FILE))
SYNC = SyncState(SYNC_FILE)


def validate_presentation_image(image: object, field: str) -> dict | None:
    if image is None:
        return None
    if not isinstance(image, dict) or not isinstance(image.get("src"), str) or not isinstance(image.get("alt"), str):
        raise ValueError(f"{field} must contain src and alt strings.")
    src = image["src"].replace("\\", "/")
    if not src.startswith("assets/") or ".." in src.split("/") or re.match(r"^[a-z]+:", src, re.I):
        raise ValueError(f"{field}.src must be beneath assets/.")
    return {"src": src, "alt": image["alt"]}


def validate_presentation_audio(audio: object, field: str) -> dict | None:
    if audio is None:
        return None
    if not isinstance(audio, dict) or not isinstance(audio.get("src"), str) or not isinstance(audio.get("label"), str):
        raise ValueError(f"{field} must contain src and label strings.")
    src = audio["src"].replace("\\", "/")
    if not src.startswith("assets/") or ".." in src.split("/") or re.match(r"^[a-z]+:", src, re.I):
        raise ValueError(f"{field}.src must be beneath assets/.")
    if not audio["label"].strip():
        raise ValueError(f"{field}.label must not be empty.")
    return {"src": src, "label": audio["label"]}


def validate_presentation(payload: object) -> dict:
    if not isinstance(payload, dict) or payload.get("screen") not in PRESENTATION_SCREENS:
        raise ValueError("Presentation screen is invalid.")
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("Presentation title is required.")
    teams = payload.get("teams", [])
    if not isinstance(teams, list):
        raise ValueError("Presentation teams must be an array.")
    clean_teams = []
    for team in teams:
        if not isinstance(team, dict) or not isinstance(team.get("name"), str):
            raise ValueError("Each presentation team needs a name.")
        score = team.get("score")
        if not isinstance(score, int) or isinstance(score, bool):
            raise ValueError("Each presentation team needs an integer score.")
        clean_teams.append({"name": team["name"], "score": score})

    clean: dict = {"screen": payload["screen"], "title": title, "teams": clean_teams}
    join_overlay = payload.get("joinOverlay")
    if join_overlay is not None:
        if not isinstance(join_overlay, dict) or not isinstance(join_overlay.get("joinUrl"), str):
            raise ValueError("Presentation join overlay is invalid.")
        join_url = join_overlay["joinUrl"]
        if not re.fullmatch(r"https?://[^/\s]+/player", join_url):
            raise ValueError("Presentation join URL is invalid.")
        clean["joinOverlay"] = {"joinUrl": join_url}
    if payload["screen"] == "hub":
        highlighted_game = payload.get("highlightedGame")
        if highlighted_game is not None and highlighted_game not in HUB_GAME_IDS:
            raise ValueError("Highlighted hub game is invalid.")
        clean["highlightedGame"] = highlighted_game
    elif payload["screen"] == "intro":
        heads_visible = payload.get("headsVisible")
        if not isinstance(heads_visible, bool):
            raise ValueError("Intro headsVisible must be a boolean.")
        clean["headsVisible"] = heads_visible
    elif payload["screen"] == "team-lobby":
        join_url = payload.get("joinUrl")
        if not isinstance(join_url, str) or not re.fullmatch(r"https?://[^/\s]+/player", join_url):
            raise ValueError("Team lobby join URL is invalid.")
        clean["joinUrl"] = join_url
    elif payload["screen"] == "warmup-question":
        question_index = payload.get("questionIndex")
        question_count = payload.get("questionCount")
        question_text = payload.get("questionText")
        concealed_image_count = payload.get("concealedImageCount")
        if (not isinstance(question_index, int) or isinstance(question_index, bool)
                or not isinstance(question_count, int) or isinstance(question_count, bool)
                or question_count <= 0 or question_index < 0 or question_index >= question_count):
            raise ValueError("Warm-up question position is invalid.")
        if not isinstance(question_text, str) or not question_text.strip() or len(question_text) > 500:
            raise ValueError("Warm-up question text is invalid.")
        if (not isinstance(concealed_image_count, int) or isinstance(concealed_image_count, bool)
                or concealed_image_count < 0 or concealed_image_count > 3):
            raise ValueError("Concealed image count is invalid.")
        clean.update({
            "questionIndex": question_index, "questionCount": question_count,
            "questionText": question_text, "concealedImageCount": concealed_image_count,
        })
    elif payload["screen"] == "jeopardy-board":
        board = payload.get("board")
        if not isinstance(board, dict):
            raise ValueError("Jeopardy board data is required.")
        categories = board.get("categories")
        values = board.get("values")
        used_tiles = board.get("usedTiles")
        if (not isinstance(categories, list) or not categories
                or any(not isinstance(item, str) for item in categories)):
            raise ValueError("Board categories are invalid.")
        if (not isinstance(values, list) or not values
                or any(not isinstance(item, int) or isinstance(item, bool) for item in values)):
            raise ValueError("Board values are invalid.")
        if (not isinstance(used_tiles, list)
                or any(not isinstance(item, str) or not TILE_ID_PATTERN.fullmatch(item) for item in used_tiles)):
            raise ValueError("Board usedTiles are invalid.")
        clean["board"] = {"categories": categories, "values": values, "usedTiles": used_tiles}
    elif payload["screen"] == "jeopardy-question":
        question = payload.get("question")
        if not isinstance(question, dict) or not isinstance(question.get("id"), str) or not TILE_ID_PATTERN.fullmatch(question["id"]):
            raise ValueError("Current question data is invalid.")
        revealed = question.get("answerRevealed")
        if not isinstance(revealed, bool):
            raise ValueError("answerRevealed must be a boolean.")
        value = question.get("value")
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError("Question value must be a positive integer.")
        question_text = question.get("question")
        answer_text = question.get("answer")
        if question_text is not None and not isinstance(question_text, str):
            raise ValueError("Question text must be a string or null.")
        if answer_text is not None and not isinstance(answer_text, str):
            raise ValueError("Answer text must be a string or null.")
        question_image = validate_presentation_image(question.get("questionImage"), "questionImage")
        answer_image = validate_presentation_image(question.get("answerImage"), "answerImage")
        question_audio = validate_presentation_audio(question.get("questionAudio"), "questionAudio")
        answer_audio = validate_presentation_audio(question.get("answerAudio"), "answerAudio")
        audio_command = question.get("audioCommand")
        clean_audio_command = None
        if audio_command is not None:
            if (not isinstance(audio_command, dict) or not isinstance(audio_command.get("id"), str)
                    or not audio_command["id"].strip()
                    or audio_command.get("action") not in {"play", "pause", "restart", "stop"}
                    or audio_command.get("target") not in {None, "question", "answer"}):
                raise ValueError("audioCommand is invalid.")
            if audio_command["action"] != "stop" and audio_command["target"] is None:
                raise ValueError("Audio playback commands require a target.")
            if audio_command["target"] == "answer" and not revealed:
                raise ValueError("Answer audio cannot be controlled before reveal.")
            if audio_command["target"] == "question" and question_audio is None:
                raise ValueError("The current question has no question audio.")
            if audio_command["target"] == "answer" and answer_audio is None:
                raise ValueError("The current question has no answer audio.")
            clean_audio_command = {
                "id": audio_command["id"], "action": audio_command["action"], "target": audio_command["target"]
            }
        if not revealed and (answer_text is not None or answer_image is not None or answer_audio is not None):
            raise ValueError("An unrevealed presentation must not contain an answer.")
        clean["question"] = {
            "id": question["id"], "value": value, "question": question_text, "questionImage": question_image,
            "questionAudio": question_audio,
            "answerRevealed": revealed, "answer": answer_text if revealed else None,
            "answerImage": answer_image if revealed else None, "answerAudio": answer_audio if revealed else None,
            "audioCommand": clean_audio_command,
        }
    elif payload["screen"] == "ordering":
        ordering_map = payload.get("orderingMap")
        clean_ordering_map = None
        if ordering_map is not None:
            if (not isinstance(ordering_map, dict)
                    or not isinstance(ordering_map.get("label"), str)
                    or not ordering_map["label"].strip()):
                raise ValueError("Order Up map needs a non-empty label.")
            map_image = validate_presentation_image(ordering_map.get("image"), "orderingMap.image")
            if map_image is None:
                raise ValueError("Order Up map needs an image.")
            clean_ordering_map = {"label": ordering_map["label"], "image": map_image}
        clean["orderingMap"] = clean_ordering_map
        selection = payload.get("questionSelection")
        if selection is not None:
            if not isinstance(selection, dict) or not isinstance(selection.get("questions"), list):
                raise ValueError("Order Up question selection is invalid.")
            clean_questions = []
            question_ids = set()
            for question in selection["questions"]:
                if (not isinstance(question, dict) or not isinstance(question.get("id"), str)
                        or not question["id"].strip() or not isinstance(question.get("title"), str)
                        or not question["title"].strip() or not isinstance(question.get("completed"), bool)):
                    raise ValueError("Each Order Up question selection needs an id, title, and completed flag.")
                if question["id"] in question_ids:
                    raise ValueError("Order Up question selection ids must be unique.")
                question_ids.add(question["id"])
                clean_questions.append({
                    "id": question["id"], "title": question["title"], "completed": question["completed"]
                })
            highlighted_id = selection.get("highlightedQuestionId")
            if highlighted_id is not None and highlighted_id not in question_ids:
                raise ValueError("Highlighted Order Up question is invalid.")
            selected_question = selection.get("selectedQuestion")
            clean_selected_question = None
            if selected_question is not None:
                if (not isinstance(selected_question, dict)
                        or selected_question.get("id") not in question_ids
                        or not isinstance(selected_question.get("title"), str)
                        or not selected_question["title"].strip()
                        or not isinstance(selected_question.get("prompt"), str)
                        or not selected_question["prompt"].strip()
                        or not isinstance(selected_question.get("items"), list)
                        or not selected_question["items"]
                        or any(not isinstance(item, str) or not item.strip() for item in selected_question["items"])):
                    raise ValueError("Selected Order Up question is invalid.")
                clean_selected_question = {
                    "id": selected_question["id"], "title": selected_question["title"],
                    "prompt": selected_question["prompt"], "items": selected_question["items"]
                }
            clean["questionSelection"] = {
                "questions": clean_questions, "highlightedQuestionId": highlighted_id,
                "selectedQuestion": clean_selected_question
            }
    elif payload["screen"] == "listing":
        preview = payload.get("questionPreview")
        clean_preview = None
        if preview is not None:
            if (not isinstance(preview, dict)
                    or not isinstance(preview.get("id"), str) or not preview["id"].strip()
                    or not isinstance(preview.get("title"), str) or not preview["title"].strip()
                    or not isinstance(preview.get("prompt"), str) or not preview["prompt"].strip()):
                raise ValueError("List It question preview is invalid.")
            clean_preview = {
                "id": preview["id"], "title": preview["title"], "prompt": preview["prompt"]
            }
        clean["questionPreview"] = clean_preview
    elif payload["screen"] == "victory":
        steps = payload.get("steps")
        revealed_count = payload.get("revealedCount")
        if not isinstance(steps, list) or not isinstance(revealed_count, int) or isinstance(revealed_count, bool):
            raise ValueError("Victory reveal data is invalid.")
        clean_steps = []
        for step in steps:
            if (not isinstance(step, dict) or step.get("kind") not in {"standing", "podium"}
                    or not isinstance(step.get("rank"), int) or isinstance(step.get("rank"), bool)
                    or not isinstance(step.get("names"), str)
                    or not isinstance(step.get("score"), int) or isinstance(step.get("score"), bool)):
                raise ValueError("A victory step is invalid.")
            clean_steps.append({"kind": step["kind"], "rank": step["rank"], "names": step["names"], "score": step["score"]})
        clean["steps"] = clean_steps
        clean["revealedCount"] = max(0, min(revealed_count, len(clean_steps)))
    return clean


class PresentationState:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.version = int(time.time() * 1000)
        self.server_session_id = f"{self.version}-{secrets.token_hex(8)}"
        self.payload = {"screen": "standby", "title": "Quiz Show", "teams": []}

    def update(self, payload: object) -> dict:
        clean = validate_presentation(payload)
        with self.condition:
            self.version += 1
            self.payload = clean
            self.condition.notify_all()
            return self._snapshot_unlocked()

    def _snapshot_unlocked(self) -> dict:
        return {"version": self.version, "serverSessionId": self.server_session_id, **self.payload}

    def snapshot(self) -> dict:
        with self.condition:
            return self._snapshot_unlocked()

    def wait_for_change(self, version: int, timeout: float = 15) -> dict | None:
        with self.condition:
            if self.version == version:
                self.condition.wait(timeout)
            return self._snapshot_unlocked() if self.version != version else None


PRESENTATION = PresentationState()


def live_state_snapshot(team_index: int | None = None, device_id: str | None = None,
                        client_id: str | None = None) -> dict:
    """Return one polling snapshot with the same role filtering as the SSE endpoints."""
    valid_client = client_id if isinstance(client_id, str) and 8 <= len(client_id) <= 100 else None
    valid_device = device_id if isinstance(device_id, str) and 8 <= len(device_id) <= 100 else None
    valid_team = team_index if isinstance(team_index, int) and 0 <= team_index < len(ORDERING.teams) else None
    if valid_client and valid_team is not None:
        ORDERING.touch_poll_connection(valid_client, valid_team)
        LISTING.touch_poll_connection(valid_client, valid_team)
    if valid_client and valid_device:
        SYNC.touch_poll_connection(valid_client, valid_device)
    team_role = "team" if valid_team is not None else "public"
    sync_role = "player" if valid_device else "public"
    return {
        "presentation": PRESENTATION.snapshot(),
        "teamLobby": TEAM_LOBBY.snapshot("player", valid_device) if valid_device else TEAM_LOBBY.snapshot(),
        "buzzer": BUZZER.snapshot(),
        "ordering": ORDERING.snapshot(team_role, valid_team),
        "listing": LISTING.snapshot(team_role, valid_team),
        "sync": SYNC.snapshot(sync_role, valid_device),
    }


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
        # A reverse tunnel reaches this process from loopback too. Cloudflare and
        # other proxies add forwarding headers, so those requests must remain public.
        if any(self.headers.get(name) for name in ("CF-Connecting-IP", "X-Forwarded-For", "Forwarded")):
            return False
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                return False
            hostname = urlsplit(f"//{self.headers.get('Host', '')}").hostname
            return hostname == "localhost" or (hostname is not None and ipaddress.ip_address(hostname).is_loopback)
        except ValueError:
            return False

    def list_directory(self, path: str):
        """Do not expose directory indexes when the server is shared publicly."""
        self.send_error(404)
        return None

    def end_headers(self) -> None:
        if not self.request_path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

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
        self.send_json(403, {"error": "Dieser Endpunkt ist nur auf dem Quiz-Host verfügbar."})
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

    def redirect_to_player(self) -> None:
        self.send_response(308)
        self.send_header("Location", "/player")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path == "/api/live-state":
            query = parse_qs(urlsplit(self.path).query)
            device_id = query.get("deviceId", [None])[0]
            client_id = query.get("clientId", [None])[0]
            try:
                team_index = int(query.get("teamIndex", [""])[0])
            except ValueError:
                team_index = None
            self.send_json(200, live_state_snapshot(team_index, device_id, client_id))
            return
        if self.request_path == "/api/team-lobby/state":
            query = parse_qs(urlsplit(self.path).query)
            device_id = query.get("deviceId", [None])[0]
            role = "player" if device_id else ("host" if self.is_host else "public")
            self.send_json(200, TEAM_LOBBY.snapshot(role, device_id))
            return
        if self.request_path == "/api/team-lobby/events":
            query = parse_qs(urlsplit(self.path).query)
            device_id = query.get("deviceId", [None])[0]
            requested_role = query.get("role", [""])[0]
            role = "player" if device_id else ("public" if requested_role == "public" else ("host" if self.is_host else "public"))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            version = -1
            try:
                while True:
                    state = TEAM_LOBBY.wait_for_change(version, role, device_id)
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
        if self.request_path == "/api/sync/state":
            query = parse_qs(urlsplit(self.path).query)
            device_id = query.get("deviceId", [None])[0]
            requested_role = query.get("role", [""])[0]
            role = "player" if device_id else ("public" if requested_role == "public" else ("host" if self.is_host else "public"))
            self.send_json(200, SYNC.snapshot(role, device_id))
            return
        if self.request_path == "/api/sync/events":
            query = parse_qs(urlsplit(self.path).query)
            device_id = query.get("deviceId", [None])[0]
            requested_role = query.get("role", [""])[0]
            role = "player" if device_id else ("public" if requested_role == "public" else ("host" if self.is_host else "public"))
            connected_participant_id = None
            if role == "player":
                connected_participant_id = SYNC.connect(device_id)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            version = -1
            try:
                while True:
                    state = SYNC.wait_for_change(version, role, device_id)
                    if state is None:
                        self.wfile.write(b": heartbeat\n\n")
                    else:
                        version = state["version"]
                        data = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
                        self.wfile.write(f"event: state\nid: {version}\ndata: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                if role == "player":
                    SYNC.disconnect(connected_participant_id)
            return
        if self.request_path == "/api/listing/state":
            query = parse_qs(urlsplit(self.path).query)
            try:
                team_index = int(query.get("teamIndex", [""])[0])
            except ValueError:
                team_index = None
            requested_role = query.get("role", [""])[0]
            role = "team" if team_index is not None else ("public" if requested_role == "public" else ("host" if self.is_host else "public"))
            self.send_json(200, LISTING.snapshot(role, team_index))
            return
        if self.request_path == "/api/listing/events":
            query = parse_qs(urlsplit(self.path).query)
            try:
                team_index = int(query.get("teamIndex", [""])[0])
            except ValueError:
                team_index = None
            requested_role = query.get("role", [""])[0]
            role = "team" if team_index is not None else ("public" if requested_role == "public" else ("host" if self.is_host else "public"))
            if role == "team":
                LISTING.connect(team_index)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            version = -1
            try:
                while True:
                    state = LISTING.wait_for_change(version, role, team_index)
                    if state is None:
                        self.wfile.write(b": heartbeat\n\n")
                    else:
                        version = state["version"]
                        data = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
                        self.wfile.write(f"event: state\nid: {version}\ndata: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                if role == "team":
                    LISTING.disconnect(team_index)
            return
        if self.request_path == "/api/ordering/state":
            query = parse_qs(urlsplit(self.path).query)
            try:
                team_index = int(query.get("teamIndex", [""])[0])
            except ValueError:
                team_index = None
            requested_role = query.get("role", [""])[0]
            role = "team" if team_index is not None else ("public" if requested_role == "public" else ("host" if self.is_host else "public"))
            self.send_json(200, ORDERING.snapshot(role, team_index))
            return
        if self.request_path == "/api/ordering/events":
            query = parse_qs(urlsplit(self.path).query)
            try:
                team_index = int(query.get("teamIndex", [""])[0])
            except ValueError:
                team_index = None
            requested_role = query.get("role", [""])[0]
            role = "team" if team_index is not None else ("public" if requested_role == "public" else ("host" if self.is_host else "public"))
            if role == "team":
                ORDERING.connect(team_index)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            version = -1
            try:
                while True:
                    state = ORDERING.wait_for_change(version, role, team_index)
                    if state is None:
                        self.wfile.write(b": heartbeat\n\n")
                    else:
                        version = state["version"]
                        data = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
                        self.wfile.write(f"event: state\nid: {version}\ndata: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                if role == "team":
                    ORDERING.disconnect(team_index)
            return
        if self.request_path == "/api/presentation/state":
            self.send_json(200, PRESENTATION.snapshot())
            return
        if self.request_path == "/api/presentation/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            version = -1
            try:
                while True:
                    state = PRESENTATION.wait_for_change(version)
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
        if self.request_path == "/api/buzzer/info":
            self.send_json(200, current_join_info())
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
                    self.send_json(404, {"error": "Es ist kein gespeichertes Spiel vorhanden."})
                    return
                try:
                    state = validate_state(json.loads(STATE_FILE.read_text(encoding="utf-8")))
                except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
                    self.send_json(500, {"error": f"Der gespeicherte Spielstand ist ungültig: {error}"})
                    return
            self.send_json(200, state)
            return
        if self.request_path in {
            "/game-state.json", "/.game-state.tmp", "/ordering-state.json", "/.ordering-state.tmp",
            "/listing-state.json", "/.listing-state.json.tmp", "/sync-state.json",
            "/.sync-state.json.tmp", "/server-questions.json",
        }:
            self.send_error(404)
            return
        if not self.is_host:
            allowed = {
                "/player", "/player.html", "/styles/player.css", "/js/player.js",
                "/buzzer", "/buzzer.html", "/styles/buzzer.css", "/js/buzzer.js",
                "/display", "/display.html", "/styles/display.css", "/styles/sync.css", "/js/display.js", "/js/intro-heads.js",
                "/js/display-score-animation.js", "/js/live-state.js", "/js/fit-text.js",
            }
            if self.request_path not in allowed and not self.request_path.startswith("/assets/"):
                self.send_error(403, "Von einem anderen Gerät sind nur die Spieler- und Publikumsansicht verfügbar.")
                return
        if self.request_path in {"/buzzer", "/buzzer.html"}:
            self.redirect_to_player()
            return
        if self.request_path == "/player":
            self.path = "/player.html"
        elif self.request_path == "/styles/buzzer.css":
            self.path = "/styles/player.css"
        elif self.request_path == "/js/buzzer.js":
            self.path = "/js/player.js"
        elif self.request_path == "/display":
            self.path = "/display.html"
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        allowed = {
            "/player", "/player.html", "/styles/player.css", "/js/player.js",
            "/buzzer", "/buzzer.html", "/styles/buzzer.css", "/js/buzzer.js",
            "/display", "/display.html", "/styles/display.css", "/styles/sync.css", "/js/display.js", "/js/intro-heads.js",
            "/js/display-score-animation.js", "/js/live-state.js", "/js/fit-text.js",
        }
        if not self.is_host and self.request_path not in allowed and not self.request_path.startswith("/assets/"):
            self.send_error(403, "Von einem anderen Gerät sind nur die Spieler- und Publikumsansicht verfügbar.")
            return
        if self.request_path in {"/buzzer", "/buzzer.html"}:
            self.redirect_to_player()
            return
        if self.request_path == "/player":
            self.path = "/player.html"
        elif self.request_path == "/styles/buzzer.css":
            self.path = "/styles/player.css"
        elif self.request_path == "/js/buzzer.js":
            self.path = "/js/player.js"
        elif self.request_path == "/display":
            self.path = "/display.html"
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path == "/api/team-lobby/player":
            try:
                status, response = TEAM_LOBBY.player_control(self.read_json(MAX_PRESENTATION_BODY_BYTES))
            except (UnicodeError, json.JSONDecodeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(status, response)
            return
        if self.request_path in {"/api/team-lobby/initialize", "/api/team-lobby/control"}:
            if not self.require_host():
                return
            try:
                payload = self.read_json(MAX_PRESENTATION_BODY_BYTES)
                response = TEAM_LOBBY.initialize(payload) if self.request_path.endswith("initialize") else TEAM_LOBBY.host_control(payload)
            except (UnicodeError, json.JSONDecodeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(200, response)
            return
        if self.request_path == "/api/sync/register":
            try:
                status, response = SYNC.register(self.read_json(MAX_PRESENTATION_BODY_BYTES))
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(status, response)
            return
        if self.request_path == "/api/sync/reconnect":
            try:
                status, response = SYNC.reconnect(self.read_json(MAX_PRESENTATION_BODY_BYTES))
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(status, response)
            return
        if self.request_path == "/api/sync/vote":
            try:
                status, response = SYNC.vote(self.read_json(MAX_PRESENTATION_BODY_BYTES))
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(status, response)
            return
        if self.request_path == "/api/sync/control":
            if not self.require_host():
                return
            try:
                payload = self.read_json(MAX_PRESENTATION_BODY_BYTES)
                response = (SYNC.awards()
                            if payload.get("action") == "awards" else SYNC.control(payload))
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(200, response)
            return
        if self.request_path == "/api/listing/submission":
            try:
                status, response = LISTING.update_submission(self.read_json(MAX_PRESENTATION_BODY_BYTES))
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(status, response)
            return
        if self.request_path == "/api/listing/control":
            if not self.require_host():
                return
            try:
                payload = self.read_json(MAX_PRESENTATION_BODY_BYTES)
                response = LISTING.awards() if payload.get("action") == "awards" else LISTING.control(payload)
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(200, response)
            return
        if self.request_path == "/api/ordering/order":
            try:
                status, response = ORDERING.update_order(self.read_json(MAX_PRESENTATION_BODY_BYTES))
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(status, response)
            return
        if self.request_path == "/api/ordering/control":
            if not self.require_host():
                return
            try:
                payload = self.read_json(MAX_PRESENTATION_BODY_BYTES)
                response = ORDERING.awards() if payload.get("action") == "awards" else ORDERING.control(payload)
            except (UnicodeError, json.JSONDecodeError, ValueError, OSError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(200, response)
            return
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
        self.send_json(404, {"error": "Unbekannter API-Endpunkt."})

    def do_PUT(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path == "/api/presentation/state":
            if not self.require_host():
                return
            try:
                response = PRESENTATION.update(self.read_json(MAX_PRESENTATION_BODY_BYTES))
            except (UnicodeError, json.JSONDecodeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(200, response)
            return
        if self.request_path != "/api/state":
            self.send_json(404, {"error": "Unbekannter API-Endpunkt."})
            return
        if not self.require_host():
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Ungültiger Content-Length-Header."})
            return
        if content_length <= 0 or content_length > MAX_STATE_BYTES:
            self.send_json(413, {"error": "Der Inhalt des Spielstands ist leer oder zu gross."})
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
                        self.send_json(409, {"error": "Eine neuere Revision des Spielstands ist bereits gespeichert."})
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
            self.send_json(500, {"error": f"Der Spielstand konnte nicht gespeichert werden: {error}"})
            return
        BUZZER.sync_teams(state)
        self.send_json(200, {"saved": True})

    def do_DELETE(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.request_path != "/api/state":
            self.send_json(404, {"error": "Unbekannter API-Endpunkt."})
            return
        if not self.require_host():
            return
        try:
            with STATE_LOCK:
                STATE_FILE.unlink(missing_ok=True)
                STATE_TEMP_FILE.unlink(missing_ok=True)
        except OSError as error:
            self.send_json(500, {"error": f"Der Spielstand konnte nicht gelöscht werden: {error}"})
            return
        BUZZER.sync_teams(None)
        ORDERING.reset()
        LISTING.reset()
        SYNC.reset()
        self.send_json(200, {"deleted": True})


class LocalQuizServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # SO_REUSEADDR allows two live servers to share one port on Windows, causing
    # requests to alternate between stale and current quiz processes.
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address) -> None:
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the quiz show server.")
    parser.add_argument(
        "--public",
        action="store_true",
        help="share player and display views through a temporary Cloudflare Quick Tunnel",
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    BUZZER.sync_teams(load_current_state())
    server: LocalQuizServer | None = None
    tunnel: QuickTunnel | None = None
    try:
        with LocalQuizServer((BIND_HOST, PORT), QuizRequestHandler) as server:
            if arguments.public:
                tunnel = QuickTunnel()
                public_url = tunnel.start()
                set_public_base_url(public_url)
            print(f"Quiz show running at {HOST_URL}")
            join_info = current_join_info()
            print(f"Player view available at {join_info['joinUrl']}")
            print(f"Audience display available at {join_info['displayUrl']}")
            if arguments.public:
                print("Only the player and audience views are public; host controls remain local.")
            elif LAN_ADDRESS == "127.0.0.1":
                print("Warning: no LAN address was found. Set QUIZ_HOST_IP to this computer's Wi-Fi IPv4 address.")
            print("Press Ctrl+C to stop the server.")
            threading.Timer(0.4, webbrowser.open, args=(HOST_URL,)).start()
            server.serve_forever()
    except OSError as error:
        raise SystemExit(
            f"Could not start the quiz at {HOST_URL}. "
            "Another program may already be using port 8000."
        ) from error
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    except KeyboardInterrupt:
        print("\nQuiz show stopped.")
    finally:
        set_public_base_url(None)
        if tunnel is not None:
            tunnel.stop()
        if server is not None:
            with contextlib.suppress(Exception):
                server.server_close()


if __name__ == "__main__":
    main()
