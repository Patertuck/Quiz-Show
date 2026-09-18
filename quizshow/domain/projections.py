"""Role-filtered snapshots derived from the authoritative session."""

from __future__ import annotations

from copy import deepcopy
from enum import StrEnum
from typing import Any

from .session import QuizSession


class ClientRole(StrEnum):
    HOST = "host"
    PLAYER = "player"
    DISPLAY = "display"


PLAYER_PRIVATE_KEYS = frozenset({
    "answer", "correctAnswer", "correctOrder", "validationRule", "votes", "submissions",
    "deviceId", "deviceIds", "hostNotes",
})
DISPLAY_PRIVATE_KEYS = frozenset({
    "validationRule", "votes", "submissions", "deviceId", "deviceIds", "hostNotes",
})


def _without_keys(value: Any, blocked: frozenset[str]) -> Any:
    if isinstance(value, dict):
        return {key: _without_keys(item, blocked) for key, item in value.items() if key not in blocked}
    if isinstance(value, list):
        return [_without_keys(item, blocked) for item in value]
    return deepcopy(value)


def project_session(session: QuizSession, role: ClientRole) -> dict[str, Any]:
    snapshot = session.model_dump(mode="json")
    if role == ClientRole.HOST:
        return snapshot
    snapshot.pop("applied_awards", None)
    snapshot.pop("shown_rule_game_ids", None)
    if role == ClientRole.PLAYER:
        snapshot.pop("score_history", None)
        snapshot["games"] = _without_keys(snapshot["games"], PLAYER_PRIVATE_KEYS)
        snapshot["buzzer"] = _without_keys(snapshot["buzzer"], PLAYER_PRIVATE_KEYS)
        snapshot["lobby"] = _without_keys(snapshot["lobby"], PLAYER_PRIVATE_KEYS)
    else:
        snapshot["games"] = _without_keys(snapshot["games"], DISPLAY_PRIVATE_KEYS)
        snapshot["buzzer"] = _without_keys(snapshot["buzzer"], DISPLAY_PRIVATE_KEYS)
        snapshot["lobby"] = _without_keys(snapshot["lobby"], DISPLAY_PRIVATE_KEYS)
    return snapshot

