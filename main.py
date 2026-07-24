"""Launch the quiz show and provide LAN-only audience and player views."""

from __future__ import annotations

import contextlib
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
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


BIND_HOST = "0.0.0.0"
HOST_URL = "http://127.0.0.1:8000/"
PORT = 8000
PROJECT_DIRECTORY = Path(__file__).resolve().parent
STATE_FILE = PROJECT_DIRECTORY / "game-state.json"
STATE_TEMP_FILE = PROJECT_DIRECTORY / ".game-state.tmp"
ORDERING_FILE = PROJECT_DIRECTORY / "ordering-state.json"
ORDERING_TEMP_FILE = PROJECT_DIRECTORY / ".ordering-state.tmp"
MAX_STATE_BYTES = 1_000_000
STATE_LOCK = threading.Lock()
TILE_ID_PATTERN = re.compile(r"^\d+:\d+$")
MAX_BUZZER_BODY_BYTES = 16_384
MAX_PRESENTATION_BODY_BYTES = 262_144
PRESENTATION_SCREENS = {"standby", "jeopardy-board", "jeopardy-question", "ordering", "victory"}


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
    return {
        "joinUrl": f"http://{address}:{PORT}/player",
        "localUrl": f"http://127.0.0.1:{PORT}/player",
        "lanAvailable": address != "127.0.0.1",
    }


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
                    raise ValueError("Für den Buzzer sind keine Teams verfügbar.")
                if not isinstance(question_id, str) or not re.fullmatch(r"\d+:\d+", question_id):
                    raise ValueError("Eine gültige questionId ist erforderlich.")
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
                    raise ValueError("Nur das hervorgehobene Team kann die Buzzer-Reihenfolge fortsetzen.")
                self.active_position += 1
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
        result = {
            "version": self.version, "teams": self.teams, "teamsRevision": self.teams_revision,
            "completedQuestionIds": self.completed, "connectedTeamCount": len(self.connections), "round": None,
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
            if self.version == version:
                self.condition.wait(wait)
            self._expire_unlocked()
            return self._snapshot_unlocked(role, team_index) if self.version != version else None

    def connect(self, team_index: int) -> None:
        with self.condition:
            if 0 <= team_index < len(self.teams):
                self.connections[team_index] = self.connections.get(team_index, 0) + 1
                self._changed_unlocked(False)

    def disconnect(self, team_index: int) -> None:
        with self.condition:
            if team_index in self.connections:
                self.connections[team_index] -= 1
                if self.connections[team_index] <= 0:
                    del self.connections[team_index]
                self._changed_unlocked(False)


ORDERING = OrderingState()


def validate_presentation_image(image: object, field: str) -> dict | None:
    if image is None:
        return None
    if not isinstance(image, dict) or not isinstance(image.get("src"), str) or not isinstance(image.get("alt"), str):
        raise ValueError(f"{field} must contain src and alt strings.")
    src = image["src"].replace("\\", "/")
    if not src.startswith("assets/") or ".." in src.split("/") or re.match(r"^[a-z]+:", src, re.I):
        raise ValueError(f"{field}.src must be beneath assets/.")
    return {"src": src, "alt": image["alt"]}


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
    if payload["screen"] == "jeopardy-board":
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
        if not revealed and (answer_text is not None or answer_image is not None):
            raise ValueError("An unrevealed presentation must not contain an answer.")
        clean["question"] = {
            "id": question["id"], "value": value, "question": question_text, "questionImage": question_image,
            "answerRevealed": revealed, "answer": answer_text if revealed else None,
            "answerImage": answer_image if revealed else None,
        }
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
        self.version = 0
        self.payload = {"screen": "standby", "title": "Quiz Show", "teams": []}

    def update(self, payload: object) -> dict:
        clean = validate_presentation(payload)
        with self.condition:
            self.version += 1
            self.payload = clean
            self.condition.notify_all()
            return self._snapshot_unlocked()

    def _snapshot_unlocked(self) -> dict:
        return {"version": self.version, **self.payload}

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

    def end_headers(self) -> None:
        if not self.request_path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
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
        if self.request_path in {"/game-state.json", "/.game-state.tmp", "/ordering-state.json", "/.ordering-state.tmp"}:
            self.send_error(404)
            return
        if not self.is_host:
            allowed = {
                "/player", "/player.html", "/styles/player.css", "/js/player.js",
                "/buzzer", "/buzzer.html", "/styles/buzzer.css", "/js/buzzer.js",
                "/display", "/display.html", "/styles/display.css", "/js/display.js",
                "/js/display-score-animation.js",
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
            "/display", "/display.html", "/styles/display.css", "/js/display.js",
            "/js/display-score-animation.js",
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
            print(f"Player view available at {JOIN_URL}")
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
