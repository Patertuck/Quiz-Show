"""Server-authoritative state for the Sync Up team game."""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path


class SyncState:
    def __init__(self, state_file: Path) -> None:
        self.state_file = state_file
        self.temp_file = state_file.with_name(f".{state_file.name}.tmp")
        self.condition = threading.Condition()
        self.version = 0
        self.config_fingerprint = ""
        self.teams: list[str] = []
        self.teams_revision = ""
        self.question_ids: list[str] = []
        self.roster_locked = False
        self.participants: list[dict] = []
        self.completed: list[str] = []
        self.sync_totals: list[int] = []
        self.round: dict | None = None
        self.finished = False
        self.distributed = False
        self.game_id = secrets.token_urlsafe(9)
        self.connections: dict[str, int] = {}
        self._load()

    @staticmethod
    def _team_revision(teams: list[str]) -> str:
        import hashlib
        encoded = json.dumps(teams, ensure_ascii=False, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()[:16]

    def _load(self) -> None:
        if not self.state_file.exists():
            return
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1:
                return
            self.config_fingerprint = data.get("configFingerprint", "")
            self.teams = data.get("teams", [])
            self.teams_revision = self._team_revision(self.teams)
            self.question_ids = data.get("questionIds", [])
            self.roster_locked = data.get("rosterLocked", False)
            self.participants = data.get("participants", [])
            self.completed = data.get("completedQuestionIds", [])
            self.sync_totals = data.get("syncTotals", [0] * len(self.teams))
            self.round = data.get("round")
            self.finished = data.get("finished", False)
            self.distributed = data.get("distributed", False)
            self.game_id = data.get("gameId") or secrets.token_urlsafe(9)
        except (OSError, UnicodeError, json.JSONDecodeError):
            self.round = None

    def _save_unlocked(self) -> None:
        data = {
            "version": 1,
            "configFingerprint": self.config_fingerprint,
            "teams": self.teams,
            "questionIds": self.question_ids,
            "rosterLocked": self.roster_locked,
            "participants": self.participants,
            "completedQuestionIds": self.completed,
            "syncTotals": self.sync_totals,
            "round": self.round,
            "finished": self.finished,
            "distributed": self.distributed,
            "gameId": self.game_id,
        }
        encoded = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        with self.temp_file.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(self.temp_file, self.state_file)

    def _changed_unlocked(self, persist: bool = True) -> None:
        if persist:
            self._save_unlocked()
        self.version += 1
        self.condition.notify_all()

    def reset(self) -> None:
        with self.condition:
            self.config_fingerprint = ""
            self.teams = []
            self.teams_revision = ""
            self.question_ids = []
            self._reset_game_unlocked()
            self.state_file.unlink(missing_ok=True)
            self.temp_file.unlink(missing_ok=True)
            self._changed_unlocked(False)

    def _reset_game_unlocked(self) -> None:
        self.roster_locked = False
        self.participants = []
        self.completed = []
        self.sync_totals = [0] * len(self.teams)
        self.round = None
        self.finished = False
        self.distributed = False
        self.game_id = secrets.token_urlsafe(9)
        self.connections = {}

    def configure(self, fingerprint: str, teams: list[str], question_ids: list[str]) -> None:
        if not fingerprint or not teams or not question_ids:
            raise ValueError("Konfiguration, Teams und Fragen für Sync Up sind erforderlich.")
        revision = self._team_revision(teams)
        with self.condition:
            incompatible = fingerprint != self.config_fingerprint or revision != self.teams_revision
            self.config_fingerprint = fingerprint
            self.teams = list(teams)
            self.teams_revision = revision
            self.question_ids = list(question_ids)
            if incompatible:
                self._reset_game_unlocked()
            else:
                self.completed = [item for item in self.completed if item in question_ids]
            self._changed_unlocked()

    def _participant_by_device_unlocked(self, device_id: str) -> dict | None:
        return next((item for item in self.participants if item["deviceId"] == device_id), None)

    def register(self, payload: dict) -> tuple[int, dict]:
        device_id = payload.get("deviceId")
        team_index = payload.get("teamIndex")
        name = payload.get("name")
        if not isinstance(device_id, str) or not 8 <= len(device_id) <= 100:
            raise ValueError("Eine gültige deviceId ist erforderlich.")
        if not isinstance(team_index, int) or isinstance(team_index, bool):
            raise ValueError("teamIndex muss eine Ganzzahl sein.")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 40:
            raise ValueError("Der Name muss 1 bis 40 Zeichen enthalten.")
        clean_name = name.strip()
        with self.condition:
            if payload.get("teamsRevision") != self.teams_revision or not 0 <= team_index < len(self.teams):
                return 409, {"error": "Die Teamliste wurde geändert. Wählt euer Team erneut.", "state": self._snapshot_unlocked("public")}
            existing = self._participant_by_device_unlocked(device_id)
            if self.roster_locked:
                if existing:
                    return 200, {"registered": True, "participantId": existing["id"], "state": self._snapshot_unlocked("player", device_id)}
                return 409, {"error": "Die Teilnehmerliste wurde bereits gesperrt.", "state": self._snapshot_unlocked("public")}
            duplicate = next((item for item in self.participants
                              if item["teamIndex"] == team_index
                              and item["name"].casefold() == clean_name.casefold()
                              and item is not existing), None)
            if duplicate:
                raise ValueError("Dieser Name wird in eurem Team bereits verwendet.")
            if existing:
                existing.update({"teamIndex": team_index, "name": clean_name})
            else:
                existing = {
                    "id": secrets.token_urlsafe(9),
                    "deviceId": device_id,
                    "teamIndex": team_index,
                    "name": clean_name,
                }
                self.participants.append(existing)
            self._changed_unlocked()
            return 200, {"registered": True, "participantId": existing["id"], "state": self._snapshot_unlocked("player", device_id)}

    def _validate_question(self, question: object) -> dict:
        if not isinstance(question, dict):
            raise ValueError("Eine Frage ist erforderlich.")
        question_id = question.get("id")
        prompt = question.get("prompt")
        seconds = question.get("timeLimitSeconds")
        if not isinstance(question_id, str) or question_id not in self.question_ids:
            raise ValueError("Die Frage gehört nicht zur Sync-Up-Konfiguration.")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Der Prompt darf nicht leer sein.")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or not 1 <= seconds <= 60:
            raise ValueError("timeLimitSeconds muss zwischen 1 und 60 liegen.")
        return {"id": question_id, "prompt": prompt.strip(), "timeLimitSeconds": seconds}

    def _expire_unlocked(self) -> None:
        if not self.round or self.round["phase"] != "active":
            return
        if int(time.time() * 1000) < self.round["deadlineAt"]:
            return
        results = []
        for team_index in range(len(self.teams)):
            members = [item for item in self.participants if item["teamIndex"] == team_index]
            selections = [self.round["votes"].get(item["id"]) for item in members]
            synced = bool(members) and all(selections) and len(set(selections)) == 1
            if synced:
                self.sync_totals[team_index] += 1
            results.append({
                "teamIndex": team_index,
                "synced": synced,
                "selectedParticipantId": selections[0] if synced else None,
                "votes": [{"participantId": item["id"], "selectedParticipantId": self.round["votes"].get(item["id"])}
                          for item in members],
            })
        self.round["phase"] = "results"
        self.round["results"] = results
        if self.round["questionId"] not in self.completed:
            self.completed.append(self.round["questionId"])
        self._changed_unlocked()

    def vote(self, payload: dict) -> tuple[int, dict]:
        device_id = payload.get("deviceId")
        selected_id = payload.get("selectedParticipantId")
        with self.condition:
            self._expire_unlocked()
            participant = self._participant_by_device_unlocked(device_id) if isinstance(device_id, str) else None
            if not participant:
                return 409, {"error": "Registriert euch erneut für Sync Up.", "state": self._snapshot_unlocked("public")}
            if not self.round or self.round["phase"] != "active" or payload.get("roundId") != self.round["id"]:
                return 409, {"error": "Die Abstimmung ist geschlossen.", "state": self._snapshot_unlocked("player", device_id)}
            selected = next((item for item in self.participants if item["id"] == selected_id), None)
            if not selected or selected["teamIndex"] != participant["teamIndex"]:
                raise ValueError("Ihr könnt nur eine Person aus eurem eigenen Team wählen.")
            self.round["votes"][participant["id"]] = selected_id
            self._changed_unlocked()
            return 200, {"saved": True, "state": self._snapshot_unlocked("player", device_id)}

    def control(self, payload: dict) -> dict:
        action = payload.get("action")
        if action == "configure":
            teams = payload.get("teams")
            ids = payload.get("questionIds")
            if (not isinstance(teams, list) or any(not isinstance(item, str) for item in teams)
                    or not isinstance(ids, list) or any(not isinstance(item, str) for item in ids)):
                raise ValueError("Ungültige Sync-Up-Konfiguration.")
            self.configure(payload.get("configFingerprint", ""), teams, ids)
            return self.snapshot("host")
        with self.condition:
            self._expire_unlocked()
            if action == "lock-roster":
                if self.roster_locked:
                    raise ValueError("Die Teilnehmerliste ist bereits gesperrt.")
                missing = [self.teams[index] for index in range(len(self.teams))
                           if not any(item["teamIndex"] == index for item in self.participants)]
                if missing:
                    raise ValueError(f"Mindestens eine Person fehlt bei: {', '.join(missing)}.")
                self.roster_locked = True
            elif action == "unlock-roster":
                if self.completed or self.round:
                    raise ValueError("Nach Spielbeginn kann die Teilnehmerliste nicht mehr entsperrt werden.")
                self.roster_locked = False
            elif action == "reset-game":
                self._reset_game_unlocked()
            elif action == "seed-test-players":
                if self.roster_locked:
                    raise ValueError("Entsperrt zuerst die Teilnehmerliste.")
                for team_index in range(len(self.teams)):
                    if any(item["teamIndex"] == team_index for item in self.participants):
                        continue
                    for player_index in range(2):
                        self.participants.append({
                            "id": secrets.token_urlsafe(9),
                            "deviceId": f"sync-test-{self.game_id}-{team_index}-{player_index}",
                            "teamIndex": team_index,
                            "name": f"Test {team_index + 1}.{player_index + 1}",
                            "isTest": True,
                        })
            elif action == "prepare":
                if not self.roster_locked:
                    raise ValueError("Sperrt zuerst die Teilnehmerliste.")
                if self.finished or self.round:
                    raise ValueError("Beendet zuerst die aktuelle Sync-Up-Ansicht.")
                question = self._validate_question(payload.get("question"))
                if question["id"] in self.completed:
                    raise ValueError("Dieser Prompt wurde bereits gespielt.")
                self.round = {
                    "id": secrets.token_urlsafe(12),
                    "questionId": question["id"],
                    "prompt": question["prompt"],
                    "timeLimitSeconds": question["timeLimitSeconds"],
                    "deadlineAt": None,
                    "phase": "prepared",
                    "votes": {},
                    "results": [],
                }
            elif action == "start":
                if not self.round or self.round["phase"] != "prepared":
                    raise ValueError("Bereitet zuerst einen Prompt vor.")
                self.round["phase"] = "active"
                self.round["deadlineAt"] = int(time.time() * 1000) + self.round["timeLimitSeconds"] * 1000
            elif action == "vote-test-players":
                if not self.round or self.round["phase"] != "active":
                    raise ValueError("Testantworten sind nur während der Abstimmung möglich.")
                for team_index in range(len(self.teams)):
                    members = [item for item in self.participants if item["teamIndex"] == team_index]
                    target = members[0]["id"] if members else None
                    for participant in members:
                        if participant.get("isTest") and target:
                            self.round["votes"][participant["id"]] = target
            elif action == "cancel":
                if not self.round or self.round["phase"] not in {"prepared", "active"}:
                    raise ValueError("Diese Runde kann nicht mehr abgebrochen werden.")
                self.round = None
            elif action == "close":
                if not self.round or self.round["phase"] != "results":
                    raise ValueError("Es sind keine Rundenergebnisse geöffnet.")
                self.round = None
            elif action == "finish":
                if self.round or not self.completed:
                    raise ValueError("Schliesst die Runde und spielt mindestens einen Prompt.")
                self.finished = True
            elif action == "confirm-distribution":
                if not self.finished:
                    raise ValueError("Beendet zuerst Sync Up.")
                self.distributed = True
            else:
                raise ValueError("Unbekannte Sync-Up-Aktion.")
            self._changed_unlocked()
            return self._snapshot_unlocked("host")

    def _standings_unlocked(self) -> list[dict]:
        results = []
        for team_index, total in enumerate(self.sync_totals):
            rank = 1 + sum(1 for other in self.sync_totals if other > total)
            results.append({"teamIndex": team_index, "syncCount": total, "rank": rank})
        return sorted(results, key=lambda item: (item["rank"], item["teamIndex"]))

    def awards(self, placement_points: object) -> dict:
        if (not isinstance(placement_points, list) or not placement_points
                or any(not isinstance(item, int) or isinstance(item, bool) or item < 0 for item in placement_points)):
            raise ValueError("placementPoints muss nicht-negative Ganzzahlen enthalten.")
        with self.condition:
            self._expire_unlocked()
            if not self.finished:
                raise ValueError("Beendet zuerst Sync Up.")
            standings = self._standings_unlocked()
            return {
                "awardId": f"sync:{self.game_id}",
                "awards": [{"teamIndex": item["teamIndex"],
                            "points": placement_points[item["rank"] - 1] if item["rank"] <= len(placement_points) else 0}
                           for item in standings],
            }

    def _public_participants_unlocked(self) -> list[dict]:
        return [{"id": item["id"], "teamIndex": item["teamIndex"], "name": item["name"],
                 "isTest": bool(item.get("isTest"))}
                for item in self.participants]

    def _snapshot_unlocked(self, role: str, device_id: str | None = None) -> dict:
        self._expire_unlocked()
        participant = self._participant_by_device_unlocked(device_id) if device_id else None
        public_participants = self._public_participants_unlocked()
        result = {
            "version": self.version,
            "teams": self.teams,
            "teamsRevision": self.teams_revision,
            "rosterLocked": self.roster_locked,
            "participants": public_participants,
            "completedQuestionIds": self.completed,
            "syncTotals": self.sync_totals,
            "standings": self._standings_unlocked(),
            "finished": self.finished,
            "distributed": self.distributed,
            "round": None,
        }
        if role == "host":
            result["connectedParticipantIds"] = sorted(self.connections)
        if role == "player" and participant:
            result["selfParticipantId"] = participant["id"]
        if not self.round:
            return result
        source = self.round
        round_data = {key: source[key] for key in (
            "id", "questionId", "prompt", "timeLimitSeconds", "deadlineAt", "phase"
        )}
        round_data["submittedCount"] = len(source["votes"])
        if role == "player" and participant:
            round_data["ownSelectionId"] = source["votes"].get(participant["id"])
        if source["phase"] == "results":
            round_data["results"] = source["results"]
        result["round"] = round_data
        return result

    def snapshot(self, role: str = "public", device_id: str | None = None) -> dict:
        with self.condition:
            return self._snapshot_unlocked(role, device_id)

    def wait_for_change(self, version: int, role: str, device_id: str | None,
                        timeout: float = 15) -> dict | None:
        with self.condition:
            self._expire_unlocked()
            wait = timeout
            if self.round and self.round["phase"] == "active":
                wait = min(wait, max(0.05, (self.round["deadlineAt"] - int(time.time() * 1000)) / 1000))
            if self.version == version:
                self.condition.wait(wait)
            self._expire_unlocked()
            return self._snapshot_unlocked(role, device_id) if self.version != version else None

    def connect(self, device_id: str) -> None:
        with self.condition:
            participant = self._participant_by_device_unlocked(device_id)
            if participant:
                participant_id = participant["id"]
                self.connections[participant_id] = self.connections.get(participant_id, 0) + 1
                self._changed_unlocked(False)

    def disconnect(self, device_id: str) -> None:
        with self.condition:
            participant = self._participant_by_device_unlocked(device_id)
            if participant and participant["id"] in self.connections:
                participant_id = participant["id"]
                self.connections[participant_id] -= 1
                if self.connections[participant_id] <= 0:
                    del self.connections[participant_id]
                self._changed_unlocked(False)
