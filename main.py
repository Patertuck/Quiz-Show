"""Launch the quiz show with local/LAN access and optional public sharing."""

from __future__ import annotations

import contextlib
import base64
import csv
import hashlib
import io
import ipaddress
import json
import os
import re
import random
import secrets
import shutil
import socket
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path
import struct

from listing_game import ListingState
from instance_state import InstanceStateStore
from quiz_library import LOGO_FILENAMES, QuizLibrary
from sync_game import SyncState


BIND_HOST = "0.0.0.0"
HOST_URL = "http://127.0.0.1:8000/"
PORT = 8000
PROJECT_DIRECTORY = Path(__file__).resolve().parent
QUIZ_DATA_DIRECTORY = PROJECT_DIRECTORY / "quiz-data"
QUIZ_VARIATION_DIRECTORY = QUIZ_DATA_DIRECTORY / "variations"
QUIZ_INSTANCE_DIRECTORY = QUIZ_DATA_DIRECTORY / "instances"
QUIZ_LIBRARY = QuizLibrary(QUIZ_VARIATION_DIRECTORY, QUIZ_INSTANCE_DIRECTORY,
                           PROJECT_DIRECTORY / "assets" / "Logos")
MAX_STATE_BYTES = 1_000_000
TILE_ID_PATTERN = re.compile(r"^\d+:\d+$")
MAX_BUZZER_BODY_BYTES = 16_384
MAX_PRESENTATION_BODY_BYTES = 262_144
MAX_FINAL_EXPORT_BODY_BYTES = 25_000_000
MAX_FINAL_EXPORT_PNG_BYTES = 8_000_000
FINAL_EXPORT_LOCK = threading.Lock()
PRESENTATION_SCREENS = {"standby", "team-lobby", "hub", "jeopardy-board", "jeopardy-question", "ordering", "listing", "sync", "victory", "score-history"}
HUB_GAME_IDS = {"jeopardy", "ordering", "listing", "sync"}

FINAL_EXPORT_GAME_LABELS = {
    "jeopardy": "Jeopardy",
    "ordering": "Order Up",
    "listing": "List It",
    "sync": "Sync Up",
}


def _decode_export_png(value: object, field: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} fehlt.")
    try:
        image = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError(f"{field} ist kein gültiges Base64-PNG.") from error
    if len(image) > MAX_FINAL_EXPORT_PNG_BYTES:
        raise ValueError(f"{field} ist zu gross.")
    if len(image) < 24 or image[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{field} ist keine PNG-Datei.")
    width, height = struct.unpack(">II", image[16:24])
    if (width, height) != (1920, 1080):
        raise ValueError(f"{field} muss 1920 × 1080 Pixel gross sein.")
    return image


def final_export_key(state: dict) -> str:
    identity = {
        "formatVersion": 2,
        "teams": state["teams"],
        "scoreHistory": state["scoreHistory"],
    }
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:12]


def final_export_csv(state: dict) -> bytes:
    teams = state["teams"]
    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter=";", lineterminator="\n")
    header = ["Schritt", "Spiel"]
    for team in teams:
        header.extend([f"{team['name']} – Punktestand", f"{team['name']} – Veränderung"])
    writer.writerow(header)
    previous = None
    for index, entry in enumerate(state["scoreHistory"]):
        game = "Start" if index == 0 else FINAL_EXPORT_GAME_LABELS.get(entry.get("game"), "Frühere Punkte")
        row: list[object] = [index, game]
        for team_index, score in enumerate(entry["scores"]):
            change = 0 if previous is None else score - previous[team_index]
            row.extend([score, change])
        writer.writerow(row)
        previous = entry["scores"]
    return output.getvalue().encode("utf-8-sig")


def save_final_export(payload: dict, state: dict, directory: Path) -> tuple[Path, bool]:
    podium = _decode_export_png(payload.get("podiumPng"), "podiumPng")
    score_history = _decode_export_png(payload.get("scoreHistoryPng"), "scoreHistoryPng")
    export_key = final_export_key(state)
    csv_bytes = final_export_csv(state)
    with FINAL_EXPORT_LOCK:
        directory.mkdir(parents=True, exist_ok=True)
        existing = next(directory.glob(f"quizshow-*_{export_key}"), None)
        if existing is not None and existing.is_dir():
            return existing, False
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        target = directory / f"quizshow-{timestamp}_{export_key}"
        temporary = directory / f".export-{secrets.token_hex(8)}"
        try:
            temporary.mkdir()
            (temporary / "podest.png").write_bytes(podium)
            (temporary / "punkteverlauf.png").write_bytes(score_history)
            (temporary / "punkteverlauf.csv").write_bytes(csv_bytes)
            os.replace(temporary, target)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
    return target, True


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
    base = f"http://{address}:{PORT}"
    return {
        "mode": "local",
        "joinUrl": f"{base}/player",
        "displayUrl": f"{base}/display",
        "localUrl": f"http://127.0.0.1:{PORT}/player",
        "localDisplayUrl": f"http://127.0.0.1:{PORT}/display",
        "lanAvailable": address != "127.0.0.1",
    }


def validate_state(state: object) -> dict:
    """Validate the stable portion of the browser-to-server state contract."""
    if not isinstance(state, dict):
        raise ValueError("State must be a JSON object.")
    if state.get("version") not in {1, 2, 3, 4, 5}:
        raise ValueError("Unsupported state version.")
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
    if state["version"] == 2:
        state = {**state, "version": 3, "scoreHistory": [{"scores": [team["score"] for team in teams]}]}
    history = state.get("scoreHistory")
    if not isinstance(history, list) or not history:
        raise ValueError("scoreHistory must be a non-empty array.")
    for entry in history:
        scores = entry.get("scores") if isinstance(entry, dict) else None
        if (not isinstance(scores, list) or len(scores) != len(teams)
                or any(not isinstance(score, int) or isinstance(score, bool) for score in scores)):
            raise ValueError("Each scoreHistory entry must contain one integer score per team.")
        game = entry.get("game")
        if state["version"] >= 4 and game not in {None, "jeopardy", "ordering", "listing", "sync"}:
            raise ValueError("Each scoreHistory entry must contain a valid game.")
    if state["version"] >= 4 and state.get("scoreHistoryGame") not in {
            None, "jeopardy", "ordering", "listing", "sync"}:
        raise ValueError("scoreHistoryGame must be a valid game or null.")
    if state["version"] == 4:
        state = {**state, "version": 5, "shownRuleGameIds": []}
    if state["version"] >= 5:
        shown_rules = state.get("shownRuleGameIds")
        if (not isinstance(shown_rules, list)
                or any(not isinstance(game, str) or game not in HUB_GAME_IDS for game in shown_rules)
                or len(shown_rules) != len(set(shown_rules))):
            raise ValueError("shownRuleGameIds must contain unique valid game ids.")
    if any(score != teams[index]["score"] for index, score in enumerate(history[-1]["scores"])):
        raise ValueError("The final scoreHistory entry must match the current team scores.")
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

    def reset(self) -> None:
        with self.condition:
            self.phase = "uninitialized"
            self.teams = []
            self.memberships = {}
            self._changed()

    def _team(self, team_id: object) -> dict:
        if not isinstance(team_id, str):
            raise ValueError("Eine gültige teamId ist erforderlich.")
        team = next((item for item in self.teams if item["id"] == team_id), None)
        if team is None:
            raise ValueError("Dieses Team existiert nicht mehr.")
        return team

    def initialize(self, payload: dict) -> dict:
        source = payload.get("teams")
        if not isinstance(source, list):
            raise ValueError("Die Team-Lobby kann nicht initialisiert werden.")
        if not 1 <= len(source) <= self.MAX_TEAMS:
            raise ValueError(f"Die Lobby benötigt 1 bis {self.MAX_TEAMS} Teams.")
        with self.condition:
            if self.phase in {"open", "locked"} and not payload.get("force"):
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

    def __init__(self, store: InstanceStateStore) -> None:
        self.store = store
        self.condition = threading.Condition()
        self.version = 0
        self.teams: list[str] = []
        self.teams_revision = ""
        self.completed: list[str] = []
        self.round: dict | None = None
        self.connections: dict[int, int] = {}
        self.poll_connections: dict[str, tuple[int, float]] = {}
        self._load()

    def _load(self) -> None:
        data = self.store.read("ordering")
        if data is None:
            return
        if data.get("version") != 1:
            raise ValueError("Der Order-Up-Spielstand hat eine ungültige Version.")
        self.teams = data.get("teams", [])
        self.teams_revision = BuzzerState.team_revision(self.teams)
        self.completed = data.get("completedQuestionIds", [])
        self.round = data.get("round")
        # Rounds persisted by older releases used exact-position scoring.
        if self.round is not None and "scoringMode" not in self.round:
            self.round["scoringMode"] = "exact"
        # Older rounds displayed points as answers were revealed.
        if self.round is not None and "pointsRevealed" not in self.round:
            self.round["pointsRevealed"] = bool(self.round.get("revealed"))

    def _save_unlocked(self) -> None:
        data = {
            "version": 1,
            "teams": self.teams, "completedQuestionIds": self.completed, "round": self.round,
        }
        self.store.write("ordering", data)

    def _changed_unlocked(self, persist: bool = True) -> None:
        if persist:
            self._save_unlocked()
        self.version += 1
        self.condition.notify_all()

    def _expire_unlocked(self) -> None:
        if self.round and self.round.get("phase") == "active" and int(time.time() * 1000) >= self.round["deadlineAt"]:
            self.round["phase"] = "locked"
            self._changed_unlocked()

    def reset(self, persist: bool = True) -> None:
        with self.condition:
            self.teams = []
            self.teams_revision = ""
            self.completed = []
            self.round = None
            self.poll_connections = {}
            if persist:
                self.store.write("ordering", None)
            self._changed_unlocked(False)

    def reload(self) -> None:
        with self.condition:
            self._reload_unlocked()

    def _reload_unlocked(self) -> None:
        self.teams = []
        self.teams_revision = ""
        self.completed = []
        self.round = None
        self.connections = {}
        self.poll_connections = {}
        self._load()
        self.version += 1
        self.condition.notify_all()

    def configure(self, teams: list[str], question_ids: list[str]) -> None:
        if not teams or not question_ids:
            raise ValueError("Teams und Fragen für Order Up sind erforderlich.")
        revision = BuzzerState.team_revision(teams)
        with self.condition:
            if revision != self.teams_revision:
                self.completed = []
                self.round = None
                self.poll_connections = {}
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
        scoring_mode = question.get("scoringMode", "relative")
        if not isinstance(items, list) or not 3 <= len(items) <= 7 or any(not isinstance(item, str) or not item.strip() for item in items):
            raise ValueError("Eine Frage benötigt 3 bis 7 Elemente.")
        if len({item.strip().casefold() for item in items}) != len(items):
            raise ValueError("Die Elemente einer Frage müssen eindeutig sein.")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
            raise ValueError("timeLimitSeconds muss eine positive Ganzzahl sein.")
        if not isinstance(points, int) or isinstance(points, bool) or points <= 0:
            raise ValueError("pointsPerCorrect muss positiv sein.")
        if scoring_mode not in {"relative", "exact"}:
            raise ValueError("scoringMode muss relative oder exact sein.")
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
                "pointsPerCorrect": clean["pointsPerCorrect"],
                "scoringMode": clean.get("scoringMode", "relative"), "correctItems": correct,
                "shuffledItems": shuffled, "teamOrders": [order.copy() for _ in self.teams],
                "deadlineAt": int(time.time() * 1000) + clean["timeLimitSeconds"] * 1000,
                "phase": "active", "revealed": [], "pointsRevealed": False,
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
            self.configure(teams, ids)
        elif action == "start":
            self.start(payload.get("question"))
        else:
            with self.condition:
                self._expire_unlocked()
                if not self.round and action != "reopen-question":
                    raise ValueError("Es gibt keine aktuelle Order-Up-Runde.")
                if action == "reopen-question":
                    if self.round:
                        raise ValueError("Beendet zuerst die aktuelle Order-Up-Runde.")
                    question_id = payload.get("questionId")
                    if not isinstance(question_id, str) or question_id not in self.completed:
                        raise ValueError("Diese Order-Up-Frage ist nicht abgeschlossen.")
                    self.completed.remove(question_id)
                elif action == "lock":
                    if self.round["phase"] != "active":
                        raise ValueError("Die Runde ist bereits gesperrt.")
                    self.round["phase"] = "locked"
                elif action == "cancel":
                    if self.round["phase"] == "distributed":
                        raise ValueError("Eine Runde mit verteilten Punkten kann nicht mehr abgebrochen werden.")
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
                elif action == "reveal-points":
                    if len(self.round["revealed"]) != len(self.round["correctItems"]):
                        raise ValueError("Deckt alle Antworten auf, bevor ihr die Punkte anzeigt.")
                    if self.round.get("pointsRevealed"):
                        raise ValueError("Die Punkte wurden bereits angezeigt.")
                    self.round["pointsRevealed"] = True
                elif action == "confirm-distribution":
                    if not self.round.get("pointsRevealed"):
                        raise ValueError("Zeigt die Punkte an, bevor ihr sie verteilt.")
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

    def _row_points_unlocked(self, team_index: int) -> list[int]:
        if not self.round:
            return []
        correct = [item["id"] for item in self.round["correctItems"]]
        order = self.round["teamOrders"][team_index]
        points = self.round["pointsPerCorrect"]
        if self.round.get("scoringMode", "exact") == "exact":
            return [points if item_id == correct[slot] else 0 for slot, item_id in enumerate(order)]
        correct_positions = {item_id: slot for slot, item_id in enumerate(correct)}
        return [
            points * sum(
                correct_positions[item_id] < correct_positions[later_id]
                for later_id in order[slot + 1:]
            )
            for slot, item_id in enumerate(order)
        ]

    def _round_points_unlocked(self, team_index: int) -> int:
        row_points = self._row_points_unlocked(team_index)
        return sum(row_points[slot] for slot in self.round["revealed"]) if self.round else 0

    def awards(self) -> dict:
        with self.condition:
            self._expire_unlocked()
            if not self.round or not self.round.get("pointsRevealed"):
                raise ValueError("Zeigt die Punkte an, bevor ihr sie verteilt.")
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
            "id", "questionId", "title", "prompt", "timeLimitSeconds", "pointsPerCorrect", "scoringMode",
            "shuffledItems", "deadlineAt", "phase", "revealed", "pointsRevealed"
        )}
        if role == "host":
            round_data["correctItems"] = self.round["correctItems"]
            round_data["teamOrders"] = self.round["teamOrders"]
            if self.round["pointsRevealed"]:
                round_data["rowPoints"] = [self._row_points_unlocked(index) for index in range(len(self.teams))]
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
            if self.round["pointsRevealed"]:
                round_data["rowPoints"] = [self._row_points_unlocked(index) for index in range(len(self.teams))]
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


INSTANCE_STATE = InstanceStateStore(QUIZ_LIBRARY.active_state_path())
ORDERING = OrderingState(INSTANCE_STATE)
LISTING = ListingState(INSTANCE_STATE)
SYNC = SyncState(INSTANCE_STATE)


def validate_quiz_media_source(value: str, field: str) -> str:
    src = value.replace("\\", "/")
    match = re.fullmatch(r"/quiz-content/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/assets/(.+)", src)
    if not match or any(part in {"", ".", ".."} for part in match.group(2).split("/")):
        raise ValueError(f"{field}.src must be a packaged quiz asset.")
    return src


def validate_presentation_image(image: object, field: str) -> dict | None:
    if image is None:
        return None
    if not isinstance(image, dict) or not isinstance(image.get("src"), str) or not isinstance(image.get("alt"), str):
        raise ValueError(f"{field} must contain src and alt strings.")
    src = validate_quiz_media_source(image["src"], field)
    return {"src": src, "alt": image["alt"]}


def validate_presentation_audio(audio: object, field: str) -> dict | None:
    if audio is None:
        return None
    if not isinstance(audio, dict) or not isinstance(audio.get("src"), str) or not isinstance(audio.get("label"), str):
        raise ValueError(f"{field} must contain src and label strings.")
    src = validate_quiz_media_source(audio["src"], field)
    if not audio["label"].strip():
        raise ValueError(f"{field}.label must not be empty.")
    return {"src": src, "label": audio["label"]}


def validate_presentation_logos(logos: object) -> dict[str, str]:
    defaults = {key: f"/assets/Logos/{filename}" for key, filename in LOGO_FILENAMES.items()}
    if logos is None:
        return defaults
    if not isinstance(logos, dict) or set(logos) != set(LOGO_FILENAMES):
        raise ValueError("Presentation logos are invalid.")
    clean = {}
    for key, filename in LOGO_FILENAMES.items():
        value = logos.get(key)
        if not isinstance(value, str):
            raise ValueError("Presentation logos are invalid.")
        escaped_filename = re.escape(filename)
        if (value != defaults[key]
                and not re.fullmatch(rf"/quiz-logos/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/{escaped_filename}", value)):
            raise ValueError("Presentation logos are invalid.")
        clean[key] = value
    return clean


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

    clean: dict = {
        "screen": payload["screen"], "title": title, "teams": clean_teams,
        "logos": validate_presentation_logos(payload.get("logos")),
    }
    audio_settings = payload.get("audioSettings")
    if audio_settings is None:
        clean["audioSettings"] = {
            "effectsEnabled": True, "tensionMusicEnabled": True, "ambientMusicEnabled": True
        }
    else:
        audio_keys = ("effectsEnabled", "tensionMusicEnabled", "ambientMusicEnabled")
        if (not isinstance(audio_settings, dict)
                or any(not isinstance(audio_settings.get(key), bool) for key in audio_keys)):
            raise ValueError("Presentation audio settings are invalid.")
        clean["audioSettings"] = {key: audio_settings[key] for key in audio_keys}
    join_overlay = payload.get("joinOverlay")
    if join_overlay is not None:
        if not isinstance(join_overlay, dict) or not isinstance(join_overlay.get("joinUrl"), str):
            raise ValueError("Presentation join overlay is invalid.")
        join_url = join_overlay["joinUrl"]
        if not re.fullmatch(r"https?://[^/\s]+/player", join_url):
            raise ValueError("Presentation join URL is invalid.")
        clean["joinOverlay"] = {"joinUrl": join_url}
    if payload["screen"] == "hub":
        games = payload.get("games")
        if (not isinstance(games, list) or not games
                or any(not isinstance(game, str) or game not in HUB_GAME_IDS for game in games)
                or len(games) != len(set(games))):
            raise ValueError("Available hub games are invalid.")
        highlighted_game = payload.get("highlightedGame")
        if highlighted_game is not None and highlighted_game not in games:
            raise ValueError("Highlighted hub game is invalid.")
        clean["games"] = games
        clean["highlightedGame"] = highlighted_game
    elif payload["screen"] == "team-lobby":
        join_url = payload.get("joinUrl")
        if not isinstance(join_url, str) or not re.fullmatch(r"https?://[^/\s]+/player", join_url):
            raise ValueError("Team lobby join URL is invalid.")
        clean["joinUrl"] = join_url
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
        highlighted_tile = board.get("highlightedTile")
        if highlighted_tile is not None:
            if not isinstance(highlighted_tile, str) or not TILE_ID_PATTERN.fullmatch(highlighted_tile):
                raise ValueError("Board highlightedTile is invalid.")
            category_index, row_index = map(int, highlighted_tile.split(":"))
            if (category_index >= len(categories) or row_index >= len(values)
                    or highlighted_tile in used_tiles):
                raise ValueError("Board highlightedTile is unavailable.")
        clean["board"] = {
            "categories": categories, "values": values, "usedTiles": used_tiles,
            "highlightedTile": highlighted_tile,
        }
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
        selection = payload.get("questionSelection")
        clean_selection = None
        if selection is not None:
            if not isinstance(selection, dict) or not isinstance(selection.get("questions"), list):
                raise ValueError("List It question selection is invalid.")
            clean_questions = []
            question_ids = set()
            for question in selection["questions"]:
                if (not isinstance(question, dict) or not isinstance(question.get("id"), str)
                        or not question["id"].strip()
                        or not isinstance(question.get("displayCategory"), str)
                        or not question["displayCategory"].strip()
                        or not isinstance(question.get("completed"), bool)):
                    raise ValueError("Each List It question selection needs an id, display category, and completed flag.")
                if question["id"] in question_ids:
                    raise ValueError("List It question selection ids must be unique.")
                question_ids.add(question["id"])
                clean_questions.append({
                    "id": question["id"], "displayCategory": question["displayCategory"],
                    "completed": question["completed"]
                })
            highlighted_id = selection.get("highlightedQuestionId")
            if highlighted_id is not None and highlighted_id not in question_ids:
                raise ValueError("Highlighted List It question is invalid.")
            selected_question = selection.get("selectedQuestion")
            clean_selected_question = None
            if selected_question is not None:
                if (not isinstance(selected_question, dict)
                        or selected_question.get("id") not in question_ids
                        or not isinstance(selected_question.get("title"), str)
                        or not selected_question["title"].strip()
                        or not isinstance(selected_question.get("prompt"), str)
                        or not selected_question["prompt"].strip()):
                    raise ValueError("Selected List It question is invalid.")
                clean_selected_question = {
                    "id": selected_question["id"], "title": selected_question["title"],
                    "prompt": selected_question["prompt"]
                }
            clean_selection = {
                "questions": clean_questions, "highlightedQuestionId": highlighted_id,
                "selectedQuestion": clean_selected_question
            }
        clean["questionSelection"] = clean_selection
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
    elif payload["screen"] == "score-history":
        history = payload.get("scoreHistory")
        if not isinstance(history, list) or not history:
            raise ValueError("Score history presentation data is invalid.")
        clean_history = []
        for entry in history:
            scores = entry.get("scores") if isinstance(entry, dict) else None
            if (not isinstance(scores, list) or len(scores) != len(clean_teams)
                    or any(not isinstance(score, int) or isinstance(score, bool) for score in scores)):
                raise ValueError("Each score history step needs one integer score per team.")
            game = entry.get("game")
            if game not in {None, "jeopardy", "ordering", "listing", "sync"}:
                raise ValueError("Each score history step needs a valid game.")
            clean_history.append({"scores": scores, "game": game})
        clean["scoreHistory"] = clean_history
    return clean


class PresentationState:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.version = int(time.time() * 1000)
        self.server_session_id = f"{self.version}-{secrets.token_hex(8)}"
        self.payload = validate_presentation({"screen": "standby", "title": "Quiz Show", "teams": []})

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


def load_current_state() -> dict | None:
    value = INSTANCE_STATE.read("game")
    if value is None:
        return None
    try:
        return validate_state(value)
    except ValueError:
        return None


def bind_active_instance() -> None:
    directory = QUIZ_LIBRARY.active_directory()
    INSTANCE_STATE.switch(directory / "state.json" if directory is not None else None)
    game = INSTANCE_STATE.read("game")
    if game is not None:
        validate_state(game)
    ORDERING.reload()
    LISTING.reload()
    SYNC.reload()
    TEAM_LOBBY.reset()
    BUZZER.sync_teams(load_current_state())
    PRESENTATION.update({
        "screen": "standby", "title": "Quizshow", "teams": [],
        "logos": QUIZ_LIBRARY.logo_urls(),
    })


def main() -> None:
    import uvicorn
    from quizshow.app import create_app

    BUZZER.sync_teams(load_current_state())
    try:
        print(f"Quiz show running at {HOST_URL}")
        join_info = current_join_info()
        print(f"Player view available at {join_info['joinUrl']}")
        print(f"Audience display available at {join_info['displayUrl']}")
        if LAN_ADDRESS == "127.0.0.1":
            print("Warning: no LAN address was found. Set QUIZ_HOST_IP to this computer's Wi-Fi IPv4 address.")
        print("Press Ctrl+C to stop the server.")
        threading.Timer(0.4, webbrowser.open, args=(HOST_URL,)).start()
        uvicorn.run(create_app(), host=BIND_HOST, port=PORT, log_level="warning")
    except OSError as error:
        raise SystemExit(
            f"Could not start the quiz at {HOST_URL}. "
            "Another program may already be using port 8000."
        ) from error
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    except KeyboardInterrupt:
        print("\nQuiz show stopped.")


if __name__ == "__main__":
    main()
