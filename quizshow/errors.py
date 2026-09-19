"""Application errors and their HTTP representation."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class ApplicationError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "application_error") -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApplicationError)
    async def handle_application_error(_request: Request, error: ApplicationError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={"error": error.message, "code": error.code},
            headers={"Cache-Control": "no-store"},
        )
