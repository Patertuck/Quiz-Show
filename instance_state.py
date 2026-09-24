"""Atomic persistence and migration for one authoritative quiz session."""

from __future__ import annotations

import copy
import json
import os
import shutil
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from quizshow.domain.session import (
    GAME_IDS,
    HostScreen,
    QuizSession,
    ScoreHistoryEntry,
    SessionPhase,
    Team,
)


class InstanceStateStore:
    VERSION = 2
    LEGACY_VERSION = 1
    SECTIONS = ("game", "ordering", "listing", "sync")

    def __init__(self, path: Path | None = None) -> None:
        self.lock = threading.RLock()
        self.path: Path | None = None
        self.data = self._empty()
        self._needs_legacy_backup = False
        self.switch(path)

    @classmethod
    def _empty(cls) -> dict:
        return {"version": cls.VERSION, "session": None}

    @staticmethod
    def _read_json(path: Path) -> dict:
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("Der zusammengeführte Spielstand ist keine gültige JSON-Datei.") from error
        if not isinstance(value, dict):
            raise ValueError("Der zusammengeführte Spielstand muss ein JSON-Objekt sein.")
        return value

    @classmethod
    def load_file(cls, path: Path) -> dict:
        value = cls._read_json(path)
        if value.get("version") == cls.LEGACY_VERSION:
            cls._validate_legacy(value)
            return value
        if value.get("version") != cls.VERSION or set(value) != {"version", "session"}:
            raise ValueError("Der zusammengeführte Spielstand hat eine ungültige Version oder Struktur.")
        if value["session"] is not None:
            QuizSession.model_validate(value["session"])
        return value

    @classmethod
    def _validate_legacy(cls, value: dict) -> None:
        unknown = set(value) - {"version", *cls.SECTIONS}
        if unknown or any(name not in value for name in cls.SECTIONS):
            raise ValueError("Der zusammengeführte Spielstand hat ungültige Abschnitte.")
        if any(value[name] is not None and not isinstance(value[name], dict) for name in cls.SECTIONS):
            raise ValueError("Jeder Spielstand-Abschnitt muss ein Objekt oder null sein.")

    @staticmethod
    def _phase_from_legacy(value: object) -> SessionPhase:
        return {
            "active": SessionPhase.ACTIVE,
            "review": SessionPhase.REVIEW,
            "results": SessionPhase.RESULTS,
            "result": SessionPhase.RESULTS,
            "complete": SessionPhase.COMPLETE,
            "completed": SessionPhase.COMPLETE,
            "prepared": SessionPhase.PREPARE,
        }.get(value, SessionPhase.IDLE)

    @classmethod
    def _session_from_legacy(cls, path: Path, legacy: dict) -> QuizSession | None:
        game = legacy.get("game")
        game_sections = {name: copy.deepcopy(legacy[name]) for name in cls.SECTIONS[1:] if legacy.get(name) is not None}
        if game is None and not game_sections:
            return None

        raw_teams = game.get("teams", []) if isinstance(game, dict) else []
        if not raw_teams:
            for state in game_sections.values():
                names = state.get("teams") if isinstance(state, dict) else None
                if isinstance(names, list) and names:
                    raw_teams = [{"name": name, "score": 0} for name in names]
                    break
        teams = [Team(name=item["name"], score=item.get("score", 0), color=item.get("color", ""))
                 for item in raw_teams]

        raw_history = game.get("scoreHistory", []) if isinstance(game, dict) else []
        history = [ScoreHistoryEntry(scores=entry.get("scores", []), game=entry.get("game")) for entry in raw_history]
        if teams and not history:
            history = [ScoreHistoryEntry(scores=[team.score for team in teams])]

        active_game = game.get("scoreHistoryGame") if isinstance(game, dict) else None
        if active_game not in GAME_IDS:
            active_game = next((name for name, state in game_sections.items() if state.get("round")), None)
        active_round = game_sections.get(active_game, {}).get("round") if active_game else None
        phase = cls._phase_from_legacy(active_round.get("phase") if isinstance(active_round, dict) else None)
        game_started = bool(game.get("gameStarted")) if isinstance(game, dict) else bool(teams)
        screen = HostScreen(active_game) if active_game and active_round else (HostScreen.HUB if game_started else HostScreen.SETUP)
        deadlines = {}
        for game_id, state in game_sections.items():
            round_state = state.get("round") if isinstance(state, dict) else None
            deadline = round_state.get("deadlineAt") if isinstance(round_state, dict) else None
            if isinstance(deadline, (int, float)) and not isinstance(deadline, bool):
                deadlines[game_id] = float(deadline) / 1000 if deadline > 100_000_000_000 else float(deadline)

        updated_at: Any = game.get("updatedAt") if isinstance(game, dict) else None
        if not updated_at:
            updated_at = datetime.fromtimestamp(path.stat().st_mtime, UTC) if path.exists() else datetime.now(UTC)
        return QuizSession(
            instance_name=path.parent.name,
            revision=max(0, game.get("revision", 0)) if isinstance(game, dict) else 0,
            updated_at=updated_at,
            game_started=game_started,
            screen=screen,
            active_game=active_game,
            phase=phase,
            teams=teams,
            score_history=history,
            shown_rule_game_ids=set(game.get("shownRuleGameIds", [])) if isinstance(game, dict) else set(),
            used_tiles=set(game.get("usedTiles", [])) if isinstance(game, dict) else set(),
            active_question=copy.deepcopy(game.get("activeQuestion")) if isinstance(game, dict) else None,
            applied_awards=set(game.get("appliedAwards", [])) if isinstance(game, dict) else set(),
            games=game_sections,
            timer_deadlines=deadlines,
        )

    @classmethod
    def _document_for_session(cls, session: QuizSession | None) -> dict:
        return {"version": cls.VERSION, "session": None if session is None else session.model_dump(mode="json")}

    @classmethod
    def _migrate_document(cls, path: Path, value: dict) -> tuple[dict, bool]:
        if value.get("version") == cls.VERSION:
            session = None if value["session"] is None else QuizSession.model_validate(value["session"])
            return cls._document_for_session(session), False
        return cls._document_for_session(cls._session_from_legacy(path, value)), True

    def switch(self, path: Path | None) -> None:
        with self.lock:
            if path is None or not path.exists():
                document, needs_backup = self._empty(), False
            else:
                raw = self.load_file(path)
                document, needs_backup = self._migrate_document(path, raw)
            self.path = path
            self.data = document
            self._needs_legacy_backup = needs_backup

    def read_session(self) -> QuizSession | None:
        with self.lock:
            value = self.data["session"]
            return None if value is None else QuizSession.model_validate(copy.deepcopy(value))

    @staticmethod
    def _legacy_game(session: QuizSession) -> dict:
        return {
            "version": 6,
            "updatedAt": session.updated_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "revision": session.revision,
            "gameStarted": session.game_started,
            "teams": [team.model_dump() for team in session.teams],
            "usedTiles": sorted(session.used_tiles),
            "activeQuestion": copy.deepcopy(session.active_question),
            "appliedAwards": sorted(session.applied_awards),
            "scoreHistory": [entry.model_dump() for entry in session.score_history],
            "scoreHistoryGame": session.active_game,
            "shownRuleGameIds": sorted(session.shown_rule_game_ids),
        }

    def read(self, section: str) -> dict | None:
        if section not in self.SECTIONS:
            raise ValueError("Unbekannter Spielstand-Abschnitt.")
        with self.lock:
            session = self.read_session()
            if session is None:
                return None
            if section == "game":
                return self._legacy_game(session)
            return copy.deepcopy(session.games.get(section))

    def _backup_path(self) -> Path:
        assert self.path is not None
        return self.path.with_name(f"{self.path.stem}.v1.backup{self.path.suffix}")

    def _save_document_unlocked(self, document: dict) -> None:
        if self.path is None:
            raise ValueError("Es ist keine Quiz-Instanz ausgewählt.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self._needs_legacy_backup and self.path.exists():
            backup = self._backup_path()
            if not backup.exists():
                shutil.copy2(self.path, backup)
        temporary = self.path.with_name(f".{self.path.name}.tmp")
        encoded = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        try:
            with temporary.open("wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def write_session(self, session: QuizSession) -> None:
        validated = QuizSession.model_validate(session.model_dump())
        candidate = self._document_for_session(validated)
        with self.lock:
            self._save_document_unlocked(candidate)
            self.data = candidate
            self._needs_legacy_backup = False

    def write(self, section: str, value: dict | None) -> None:
        if section not in self.SECTIONS or section == "game" or (value is not None and not isinstance(value, dict)):
            raise ValueError("Ungültiger Spielstand-Abschnitt.")
        with self.lock:
            session = self.read_session()
            if session is None:
                session = QuizSession.empty(self.path.parent.name if self.path else "unbound")
            if value is None:
                session.games.pop(section, None)
                session.timer_deadlines.pop(section, None)
            else:
                session.games[section] = copy.deepcopy(value)
                round_state = value.get("round")
                deadline = round_state.get("deadlineAt") if isinstance(round_state, dict) else None
                if isinstance(deadline, (int, float)) and not isinstance(deadline, bool):
                    session.timer_deadlines[section] = (
                        float(deadline) / 1000 if deadline > 100_000_000_000 else float(deadline)
                    )
                else:
                    session.timer_deadlines.pop(section, None)
            self.write_session(session)

    def write_game(self, value: dict, current_revision: int | None = None) -> bool:
        if not isinstance(value, dict):
            raise ValueError("Ungültiger Spielstand.")
        with self.lock:
            current = self.read_session()
            if current_revision is not None and current is not None and current.revision > current_revision:
                return False
            legacy = {
                "version": self.LEGACY_VERSION,
                "game": copy.deepcopy(value),
                "ordering": None if current is None else copy.deepcopy(current.games.get("ordering")),
                "listing": None if current is None else copy.deepcopy(current.games.get("listing")),
                "sync": None if current is None else copy.deepcopy(current.games.get("sync")),
            }
            candidate = self._session_from_legacy(self.path or Path("unbound/state.json"), legacy)
            assert candidate is not None
            if current is not None:
                candidate.lobby = copy.deepcopy(current.lobby)
                candidate.buzzer = copy.deepcopy(current.buzzer)
            self.write_session(candidate)
            return True

    def clear(self) -> None:
        with self.lock:
            self.data = self._empty()
            self._needs_legacy_backup = False
            if self.path is not None:
                self.path.unlink(missing_ok=True)
                self.path.with_name(f".{self.path.name}.tmp").unlink(missing_ok=True)
