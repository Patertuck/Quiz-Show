"""FastAPI dependency accessors."""

from fastapi import Request

from .container import ApplicationContainer


def get_container(request: Request) -> ApplicationContainer:
    container = getattr(request.app.state, "container", None)
    if not isinstance(container, ApplicationContainer):
        raise RuntimeError("The application container has not been initialized.")
    return container

