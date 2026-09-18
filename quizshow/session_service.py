"""Thread-safe command boundary around one authoritative session."""

from __future__ import annotations

import threading

from .domain.commands import CommandModel, apply_command
from .domain.projections import ClientRole, project_session
from .domain.session import QuizSession
from .services import Clock


class StaleSessionError(ValueError):
    pass


class SessionService:
    def __init__(self, clock: Clock, session: QuizSession | None = None) -> None:
        self.clock = clock
        self._session = session
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
            self._session = apply_command(self._session, command, self.clock.now())
            return self._session.model_copy(deep=True)

    def snapshot(self, role: ClientRole) -> dict:
        with self._lock:
            if self._session is None:
                return {"session": None}
            return project_session(self._session, role)

