"""Server-authoritative state and manual review for the List It game."""

from __future__ import annotations

import json
import secrets
import threading
import time
from instance_state import InstanceStateStore


class ListingState:
    """Persistent state machine for timed, manually reviewed list rounds."""

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

    @staticmethod
    def team_revision(teams: list[str]) -> str:
        import hashlib
        encoded = json.dumps(teams, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]

    def _load(self) -> None:
        data = self.store.read("listing")
        if data is None:
            return
        if data.get("version") != 1:
            raise ValueError("Der List-It-Spielstand hat eine ungültige Version.")
        self.teams = data.get("teams", [])
        self.teams_revision = self.team_revision(self.teams)
        self.completed = data.get("completedQuestionIds", [])
        self.round = data.get("round")
        if self.round and self.round.get("phase") == "classifying":
            self.round["phase"] = "active"
            self.round["deadlineAt"] = 0

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

    def _save_unlocked(self) -> None:
        data = {
            "version": 1,
            "teams": self.teams,
            "completedQuestionIds": self.completed,
            "round": self.round,
        }
        self.store.write("listing", data)

    def _changed_unlocked(self, persist: bool = True) -> None:
        if persist:
            self._save_unlocked()
        self.version += 1
        self.condition.notify_all()

    def reset(self, persist: bool = True) -> None:
        with self.condition:
            self.teams = []
            self.teams_revision = ""
            self.completed = []
            self.round = None
            if persist:
                self.store.write("listing", None)
            self._changed_unlocked(False)

    def configure(self, teams: list[str], question_ids: list[str]) -> None:
        if not teams or not question_ids:
            raise ValueError("Teams und Fragen für List It sind erforderlich.")
        revision = self.team_revision(teams)
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
            raise ValueError("Eine List-It-Frage ist erforderlich.")
        for field in ("id", "title", "prompt", "validationRule"):
            if not isinstance(question.get(field), str) or not question[field].strip():
                raise ValueError(f"Das Fragenfeld {field} ist erforderlich.")
        seconds = question.get("timeLimitSeconds")
        maximum = question.get("maxItems")
        points = question.get("placementPoints")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or not 5 <= seconds <= 600:
            raise ValueError("timeLimitSeconds muss zwischen 5 und 600 liegen.")
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 50:
            raise ValueError("maxItems muss zwischen 1 und 50 liegen.")
        if (not isinstance(points, list) or not points
                or any(not isinstance(point, int) or isinstance(point, bool) or point < 0 for point in points)):
            raise ValueError("placementPoints muss nicht-negative Ganzzahlen enthalten.")
        return question

    def start(self, question: object) -> None:
        clean = self._validate_question(question)
        with self.condition:
            self._expire_unlocked()
            if not self.teams:
                raise ValueError("Richtet Teams ein, bevor ihr List It startet.")
            if self.round and self.round.get("phase") != "distributed":
                raise ValueError("Beendet oder brecht zuerst die aktuelle List-It-Runde ab.")
            if clean["id"] in self.completed:
                raise ValueError("Diese List-It-Frage wurde bereits abgeschlossen.")
            self.round = {
                "id": secrets.token_urlsafe(12),
                "questionId": clean["id"],
                "title": clean["title"],
                "prompt": clean["prompt"],
                "validationRule": clean["validationRule"],
                "timeLimitSeconds": clean["timeLimitSeconds"],
                "maxItems": clean["maxItems"],
                "placementPoints": list(clean["placementPoints"]),
                "deadlineAt": int(time.time() * 1000) + clean["timeLimitSeconds"] * 1000,
                "phase": "active",
                "drafts": [[] for _ in self.teams],
                "submitted": [False for _ in self.teams],
                "entries": [],
                "reviewQueue": [],
                "reviewIndex": 0,
                "decisions": {},
                "resultView": None,
            }
            self._changed_unlocked()

    @staticmethod
    def _normalize_items(items: object, maximum: int) -> list[str]:
        if not isinstance(items, list):
            raise ValueError("items muss eine Liste sein.")
        clean: list[str] = []
        seen: set[str] = set()
        for value in items:
            if not isinstance(value, str):
                raise ValueError("Jeder Eintrag muss Text sein.")
            text = " ".join(value.strip().split())
            if not text:
                continue
            if len(text) > 100:
                raise ValueError("Ein Eintrag darf höchstens 100 Zeichen lang sein.")
            key = text.casefold()
            if key not in seen:
                seen.add(key)
                clean.append(text)
        if len(clean) > maximum:
            raise ValueError(f"Es sind höchstens {maximum} Einträge erlaubt.")
        return clean

    def update_submission(self, payload: dict) -> tuple[int, dict]:
        team_index = payload.get("teamIndex")
        with self.condition:
            self._expire_unlocked()
            if (not self.round or self.round["phase"] != "active"
                    or payload.get("roundId") != self.round["id"]):
                return 409, {"error": "Die Zeit ist abgelaufen oder die Runde wurde gewechselt.",
                             "state": self._snapshot_unlocked("team", team_index)}
            if (payload.get("teamsRevision") != self.teams_revision
                    or not isinstance(team_index, int) or isinstance(team_index, bool)
                    or not 0 <= team_index < len(self.teams)):
                return 409, {"error": "Die Teamliste wurde geändert. Wählt euer Team erneut.",
                             "state": self._snapshot_unlocked("public")}
            if self.round["submitted"][team_index]:
                return 409, {"error": "Eure Liste wurde bereits abgegeben.",
                             "state": self._snapshot_unlocked("team", team_index)}
            self.round["drafts"][team_index] = self._normalize_items(
                payload.get("items"), self.round["maxItems"])
            if payload.get("submit") is True:
                self.round["submitted"][team_index] = True
            self._changed_unlocked()
            return 200, {"saved": True, "state": self._snapshot_unlocked("team", team_index)}

    def _expire_unlocked(self) -> None:
        if (self.round and self.round.get("phase") == "active"
                and int(time.time() * 1000) >= self.round["deadlineAt"]):
            self._begin_review_unlocked()

    def _begin_review_unlocked(self) -> None:
        if not self.round or self.round["phase"] != "active":
            return
        self.round["submitted"] = [True for _ in self.teams]
        entries = []
        for team_index, items in enumerate(self.round["drafts"]):
            for item_index, text in enumerate(items):
                entries.append({
                    "id": f"t{team_index}-i{item_index}",
                    "teamIndex": team_index,
                    "text": text,
                    "canonical": text.casefold(),
                })
        self.round["entries"] = entries
        self.round["reviewQueue"] = [entry["id"] for entry in entries]
        self.round["reviewIndex"] = 0
        self.round["decisions"] = {}
        self.round["phase"] = "review" if entries else "results"
        self.round["resultView"] = None if entries else {"mode": "team", "teamPosition": 0}
        self._changed_unlocked()

    def _entry_unlocked(self, item_id: str) -> dict:
        if not self.round:
            raise ValueError("Es gibt keine aktuelle Runde.")
        entry = next((item for item in self.round["entries"] if item["id"] == item_id), None)
        if not entry:
            raise ValueError("Der Eintrag gehört nicht zu dieser Runde.")
        return entry

    def _accepted_unlocked(self, entry: dict) -> bool:
        if entry["id"] in self.round["decisions"]:
            return self.round["decisions"][entry["id"]] in (True, 1)
        return False

    def _count_impact_unlocked(self, entry: dict) -> int:
        if entry["id"] in self.round["decisions"]:
            decision = self.round["decisions"][entry["id"]]
            if decision is True or decision == 1:
                return 1
            if decision == -1:
                return -1
            return 0
        return 0

    def _results_unlocked(self) -> list[dict]:
        if not self.round:
            return []
        team_items: list[list[dict]] = [[] for _ in self.teams]
        counts: list[int] = []
        for team_index in range(len(self.teams)):
            counted_canonicals: set[str] = set()
            penalties = 0
            for entry in self.round["entries"]:
                if entry["teamIndex"] != team_index:
                    continue
                impact = self._count_impact_unlocked(entry)
                if impact == -1:
                    status = "penalized"
                    penalties += 1
                elif impact == 0:
                    status = "rejected"
                elif entry["canonical"] in counted_canonicals:
                    status = "duplicate"
                else:
                    status = "counted"
                    counted_canonicals.add(entry["canonical"])
                team_items[team_index].append({
                    "itemId": entry["id"], "text": entry["text"],
                    "status": status, "accepted": impact == 1,
                })
            counts.append(len(counted_canonicals) - penalties)
        sorted_counts = sorted(counts, reverse=True)
        results = []
        for team_index, count in enumerate(counts):
            place = sorted_counts.index(count) + 1
            points = (self.round["placementPoints"][place - 1]
                      if count > 0 and place <= len(self.round["placementPoints"]) else 0)
            results.append({
                "teamIndex": team_index,
                "acceptedCount": count,
                "place": place,
                "points": points,
                "items": team_items[team_index],
            })
        return results

    def _ordered_results_unlocked(self) -> list[dict]:
        return sorted(
            self._results_unlocked(),
            key=lambda item: (item["place"], -item["acceptedCount"], item["teamIndex"]),
        )

    def control(self, payload: dict) -> dict:
        action = payload.get("action")
        if action == "configure":
            teams = payload.get("teams")
            ids = payload.get("questionIds")
            if (not isinstance(teams, list) or any(not isinstance(item, str) for item in teams)
                    or not isinstance(ids, list) or any(not isinstance(item, str) for item in ids)):
                raise ValueError("Ungültige List-It-Konfiguration.")
            self.configure(teams, ids)
        elif action == "start":
            self.start(payload.get("question"))
        else:
            with self.condition:
                self._expire_unlocked()
                if not self.round and action != "reopen-question":
                    raise ValueError("Es gibt keine aktuelle List-It-Runde.")
                if action == "lock":
                    self._begin_review_unlocked()
                    return self._snapshot_unlocked("host")
                if action == "cancel":
                    if self.round["phase"] == "distributed":
                        raise ValueError("Eine Runde mit verteilten Punkten kann nicht mehr abgebrochen werden.")
                    self.round = None
                elif action == "reopen-question":
                    if self.round:
                        raise ValueError("Beendet zuerst die aktuelle List-It-Runde.")
                    question_id = payload.get("questionId")
                    if not isinstance(question_id, str) or question_id not in self.completed:
                        raise ValueError("Diese List-It-Frage ist nicht abgeschlossen.")
                    self.completed.remove(question_id)
                elif action == "decide":
                    if self.round["phase"] != "review":
                        raise ValueError("Es gibt momentan keinen Eintrag zu prüfen.")
                    item_id = payload.get("itemId")
                    impact = payload.get("countImpact")
                    if impact is None and isinstance(payload.get("accepted"), bool):
                        impact = 1 if payload["accepted"] else 0
                    if (item_id not in self.round["reviewQueue"]
                            or isinstance(impact, bool) or impact not in {-1, 0, 1}):
                        raise ValueError("Ungültige Prüfentscheidung.")
                    self.round["decisions"][item_id] = impact
                    current = self.round["reviewQueue"].index(item_id)
                    self.round["reviewIndex"] = min(current + 1, len(self.round["reviewQueue"]) - 1)
                elif action == "navigate":
                    if self.round["phase"] != "review":
                        raise ValueError("Es gibt momentan keine Prüfwarteschlange.")
                    index = payload.get("index")
                    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(self.round["reviewQueue"]):
                        raise ValueError("Ungültige Position in der Prüfwarteschlange.")
                    self.round["reviewIndex"] = index
                elif action == "finish-review":
                    if self.round["phase"] != "review":
                        raise ValueError("Die Runde ist nicht in der Prüfung.")
                    if any(item_id not in self.round["decisions"] for item_id in self.round["reviewQueue"]):
                        raise ValueError("Entscheidet zuerst über alle Einträge.")
                    self.round["phase"] = "results"
                    self.round["resultView"] = {"mode": "team", "teamPosition": 0}
                elif action == "toggle-result-item":
                    if self.round["phase"] != "results":
                        raise ValueError("Ergebnisse können nur vor der Punkteverteilung geändert werden.")
                    item_id = payload.get("itemId")
                    if not isinstance(item_id, str):
                        raise ValueError("Ungültiger Ergebnis-Eintrag.")
                    entry = self._entry_unlocked(item_id)
                    current_impact = self._count_impact_unlocked(entry)
                    self.round["decisions"][item_id] = 0 if current_impact == 1 else 1
                    ordered_results = self._ordered_results_unlocked()
                    team_position = next(
                        index for index, result in enumerate(ordered_results)
                        if result["teamIndex"] == entry["teamIndex"]
                    )
                    self.round["resultView"] = {"mode": "team", "teamPosition": team_position}
                elif action == "result-navigate":
                    if self.round["phase"] != "results":
                        raise ValueError("Die Teamseiten sind momentan nicht verfügbar.")
                    position = payload.get("teamPosition")
                    if (not isinstance(position, int) or isinstance(position, bool)
                            or not 0 <= position < len(self.teams)):
                        raise ValueError("Ungültige Teamseite.")
                    self.round["resultView"] = {"mode": "team", "teamPosition": position}
                elif action == "result-ranking":
                    if self.round["phase"] != "results":
                        raise ValueError("Die Rangliste ist momentan nicht verfügbar.")
                    self.round["resultView"] = {"mode": "ranking", "teamPosition": 0}
                elif action == "result-teams":
                    if self.round["phase"] != "results":
                        raise ValueError("Die Teamseiten sind momentan nicht verfügbar.")
                    self.round["resultView"] = {"mode": "team", "teamPosition": 0}
                elif action == "confirm-distribution":
                    if self.round["phase"] != "results":
                        raise ValueError("Die Ergebnisse sind noch nicht bereit.")
                    self.round["phase"] = "distributed"
                    self.round["resultView"] = {"mode": "ranking", "teamPosition": 0}
                    if self.round["questionId"] not in self.completed:
                        self.completed.append(self.round["questionId"])
                elif action == "close":
                    if self.round["phase"] != "distributed":
                        raise ValueError("Verteilt zuerst die Punkte.")
                    self.round = None
                else:
                    raise ValueError("Unbekannte List-It-Aktion.")
                self._changed_unlocked()
        return self.snapshot("host")

    def awards(self) -> dict:
        with self.condition:
            self._expire_unlocked()
            if not self.round or self.round["phase"] != "results":
                raise ValueError("Die Ergebnisse sind noch nicht bereit.")
            return {
                "awardId": f"listing:{self.round['id']}",
                "awards": [{"teamIndex": item["teamIndex"], "points": item["points"]}
                           for item in self._results_unlocked()],
            }

    def _snapshot_unlocked(self, role: str, team_index: int | None = None) -> dict:
        self._expire_unlocked()
        self._prune_poll_connections_unlocked()
        connected_teams = set(self.connections)
        connected_teams.update(team for team, _expires in self.poll_connections.values())
        result = {
            "version": self.version,
            "teams": self.teams,
            "teamsRevision": self.teams_revision,
            "completedQuestionIds": self.completed,
            "connectedTeamCount": len(connected_teams),
            "round": None,
        }
        if not self.round:
            return result
        source = self.round
        round_data = {key: source[key] for key in (
            "id", "questionId", "title", "prompt", "timeLimitSeconds", "maxItems",
            "placementPoints", "deadlineAt", "phase", "submitted"
        )}
        round_data["submittedCount"] = sum(source["submitted"])
        if role == "team":
            if isinstance(team_index, int) and 0 <= team_index < len(self.teams):
                round_data["teamItems"] = list(source["drafts"][team_index])
                round_data["teamSubmitted"] = source["submitted"][team_index]
        elif source["phase"] == "review" and source["reviewQueue"]:
            item_id = source["reviewQueue"][source["reviewIndex"]]
            entry = self._entry_unlocked(item_id)
            round_data["review"] = {
                "itemId": item_id,
                "text": entry["text"],
                "teamIndex": entry["teamIndex"],
                "index": source["reviewIndex"],
                "total": len(source["reviewQueue"]),
                "decidedCount": len(source["decisions"]),
                "decision": source["decisions"].get(item_id),
            }
        if source["phase"] in {"results", "distributed"}:
            round_data["results"] = self._ordered_results_unlocked()
            if role != "host":
                round_data["results"] = [
                    {
                        **result,
                        "items": [
                            {"text": item["text"], "status": item["status"]}
                            for item in result["items"]
                        ],
                    }
                    for result in round_data["results"]
                ]
            result_view = source.get("resultView")
            if not isinstance(result_view, dict) or result_view.get("mode") not in {"team", "ranking"}:
                result_view = {
                    "mode": "ranking" if source["phase"] == "distributed" else "team",
                    "teamPosition": 0,
                }
            round_data["resultView"] = result_view
        if role == "host":
            round_data["drafts"] = source["drafts"]
            round_data["decisions"] = source["decisions"]
        result["round"] = round_data
        return result

    def snapshot(self, role: str = "public", team_index: int | None = None) -> dict:
        with self.condition:
            return self._snapshot_unlocked(role, team_index)

    def wait_for_change(self, version: int, role: str, team_index: int | None,
                        timeout: float = 15) -> dict | None:
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
