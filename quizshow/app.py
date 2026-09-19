"""FastAPI application factory used during and after the server migration."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import Depends, FastAPI
from pydantic import BaseModel

from .container import ApplicationContainer
from .dependencies import get_container
from .errors import install_exception_handlers
from .http_routes import install_http_routes
from .logging import install_request_logging
from .realtime import install_realtime, run_deadline_coordinator
from .settings import Settings


class HealthResponse(BaseModel):
    status: str
    active_instance: str | None


def create_app(
    settings: Settings | None = None,
    *,
    container: ApplicationContainer | None = None,
) -> FastAPI:
    if settings is not None and container is not None and container.settings != settings:
        raise ValueError("settings and container settings must match")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.container = container or ApplicationContainer.build(settings)
        app.state.deadline_changed = asyncio.Event()
        deadline_task = asyncio.create_task(run_deadline_coordinator(app))
        try:
            yield
        finally:
            deadline_task.cancel()
            with suppress(asyncio.CancelledError):
                await deadline_task
            await app.state.container.close()

    app = FastAPI(title="Quizshow", version="0.1.0", lifespan=lifespan)
    install_exception_handlers(app)
    install_request_logging(app)

    @app.get("/api/health", response_model=HealthResponse)
    def health(current: ApplicationContainer = Depends(get_container)) -> HealthResponse:
        return HealthResponse(
            status="ok",
            active_instance=current.quiz_library.active_instance_name(),
        )

    install_realtime(app)
    install_http_routes(app)

    return app
