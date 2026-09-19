"""Small, structured logging setup for the HTTP application."""

import logging
import time
import uuid

from fastapi import FastAPI, Request


LOGGER = logging.getLogger("quizshow.http")


def install_request_logging(app: FastAPI) -> None:
    @app.middleware("http")
    async def log_request(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        LOGGER.info(
            "request_complete method=%s path=%s status=%d duration_ms=%.1f request_id=%s",
            request.method, request.url.path, response.status_code,
            (time.perf_counter() - started) * 1000, request_id,
        )
        return response
