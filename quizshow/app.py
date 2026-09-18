"""FastAPI application factory used during and after the server migration."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from pydantic import BaseModel

from .container import ApplicationContainer
from .dependencies import get_container
from .errors import install_exception_handlers
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
        try:
            yield
        finally:
            await app.state.container.close()

    app = FastAPI(title="Quizshow", version="0.1.0", lifespan=lifespan)
    install_exception_handlers(app)

    @app.get("/api/health", response_model=HealthResponse)
    def health(current: ApplicationContainer = Depends(get_container)) -> HealthResponse:
        return HealthResponse(
            status="ok",
            active_instance=current.quiz_library.active_instance_name(),
        )

    return app

