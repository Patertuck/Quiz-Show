"""Typed request and response contracts shared by HTTP and WebSocket transports."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ErrorResponse(BaseModel):
    error: str
    code: str = "request_error"
    details: list[dict[str, Any]] | None = None


class HostCommandEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    instance_name: str = Field(alias="instanceName", min_length=1)
    expected_revision: int = Field(alias="expectedRevision", ge=0)
    command: dict[str, Any]


class PlayerCommandEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal[
        "team-lobby", "buzz", "ordering", "listing", "sync-team", "sync-register", "sync-reconnect", "sync-vote"
    ]
    payload: dict[str, Any]


class CommandAccepted(BaseModel):
    accepted: bool = True
    revision: int


class LiveMessage(BaseModel):
    type: Literal["snapshot", "pong"]
    data: dict[str, Any] | None = None
