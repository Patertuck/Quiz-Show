"""Dependency container for one isolated quiz-server process."""

from __future__ import annotations

from dataclasses import dataclass

from instance_state import InstanceStateStore
from quiz_library import QuizLibrary

from .domain.session import QuizSession
from .services import Clock, ConnectionRegistry, ExportService, SystemClock
from .session_service import SessionService
from .settings import Settings


@dataclass(slots=True)
class ApplicationContainer:
    settings: Settings
    quiz_library: QuizLibrary
    state_store: InstanceStateStore
    connections: ConnectionRegistry
    clock: Clock
    exports: ExportService
    session: SessionService

    @classmethod
    def build(cls, settings: Settings | None = None, *, clock: Clock | None = None) -> "ApplicationContainer":
        resolved = settings or Settings.from_project_root()
        library = QuizLibrary(
            resolved.variation_directory,
            resolved.instance_directory,
            resolved.logo_directory,
        )
        session_clock = clock or SystemClock()
        active_name = library.active_instance_name()
        return cls(
            settings=resolved,
            quiz_library=library,
            state_store=InstanceStateStore(library.active_state_path()),
            connections=ConnectionRegistry(),
            clock=session_clock,
            exports=ExportService(),
            session=SessionService(
                session_clock,
                None if active_name is None else QuizSession.empty(active_name),
            ),
        )

    async def close(self) -> None:
        await self.connections.close_all()
