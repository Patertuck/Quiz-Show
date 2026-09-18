"""Thread-safe command boundary around one authoritative session."""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from .domain.commands import CommandModel, apply_command
from .domain.projections import ClientRole, project_session
from .domain.session import QuizSession
from .services import Clock

if TYPE_CHECKING:
    from instance_state import InstanceStateStore


class StaleSessionError(ValueError):
    pass


class SessionService:
    def __init__(self, clock: Clock, session: QuizSession | None = None,
                 repository: "InstanceStateStore | None" = None) -> None:
        self.clock = clock
        self._session = session
        self._repository = repository
        self._lock = threading.RLock()

    def bind(self, session: QuizSession | None) -> None:
        with self._lock:
            self._session = session.model_copy(deep=True) if session else None

    def execute(self, command: CommandModel, *, instance_name: str, expected_revision: int) -> QuizSession:
        with self._lock:
            if self._session is None or self._session.instance_name != instance_name:
                raise StaleSessionError("the active quiz instance changed")
            if self._session.revision != expected_revision:
                raise StaleSessionError("the quiz session revision changed")
            candidate = apply_command(self._session, command, self.clock.now())
            if self._repository is not None:
                self._repository.write_session(candidate)
            self._session = candidate
            return self._session.model_copy(deep=True)

    def snapshot(self, role: ClientRole) -> dict:
        with self._lock:
            if self._session is None:
                return {"session": None}
            return project_session(self._session, role)

    def expire_due_round(self) -> bool:
        """Persist an expired active round before exposing a restored session."""
        with self._lock:
            if self._session is None or self._session.active_game is None:
                return False
            deadline = self._session.timer_deadlines.get(self._session.active_game)
            if self._session.phase.value != "active" or deadline is None or deadline > self.clock.now():
                return False
            candidate = self._session.model_copy(deep=True)
            candidate.phase = type(candidate.phase).REVIEW
            candidate.timer_deadlines.pop(candidate.active_game, None)
            candidate.revision += 1
            candidate.updated_at = datetime.fromtimestamp(self.clock.now(), UTC)
            candidate = QuizSession.model_validate(candidate.model_dump())
            if self._repository is not None:
                self._repository.write_session(candidate)
            self._session = candidate
            return True
