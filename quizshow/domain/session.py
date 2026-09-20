"""Durable, server-owned state for one running quiz instance."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

GAME_IDS = frozenset({"jeopardy", "ordering", "listing", "sync"})


class HostScreen(StrEnum):
    START = "start"
    SETUP = "setup"
    HUB = "hub"
    JEOPARDY = "jeopardy"
    ORDERING = "ordering"
    LISTING = "listing"
    SYNC = "sync"
    VICTORY = "victory"


class SessionPhase(StrEnum):
    IDLE = "idle"
    PREPARE = "prepare"
    ACTIVE = "active"
    REVIEW = "review"
    RESULTS = "results"
    COMPLETE = "complete"


class Team(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=40)
    score: int = 0


class ScoreHistoryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scores: list[int]
    game: str | None = None


class QuizSession(BaseModel):
    """The only durable authority for host, player, and display state."""

    model_config = ConfigDict(extra="forbid")

    instance_name: str = Field(min_length=1)
    revision: int = Field(default=0, ge=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    game_started: bool = False
    screen: HostScreen = HostScreen.START
    active_game: str | None = None
    phase: SessionPhase = SessionPhase.IDLE
    teams: list[Team] = Field(default_factory=list)
    score_history: list[ScoreHistoryEntry] = Field(default_factory=list)
    shown_rule_game_ids: set[str] = Field(default_factory=set)
    used_tiles: set[str] = Field(default_factory=set)
    active_question: dict[str, Any] | None = None
    presentation: dict[str, Any] = Field(default_factory=dict)
    applied_awards: set[str] = Field(default_factory=set)
    lobby: dict[str, Any] = Field(default_factory=dict)
    buzzer: dict[str, Any] = Field(default_factory=dict)
    games: dict[str, dict[str, Any]] = Field(default_factory=dict)
    timer_deadlines: dict[str, float] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_invariants(self) -> QuizSession:
        names = [team.name.casefold() for team in self.teams]
        if len(names) != len(set(names)):
            raise ValueError("team names must be unique")
        if self.active_game is not None and self.active_game not in GAME_IDS:
            raise ValueError("active_game must be a supported game")
        if not self.shown_rule_game_ids.issubset(GAME_IDS):
            raise ValueError("shown rules must refer to supported games")
        if set(self.games) - GAME_IDS:
            raise ValueError("games contains an unsupported game")
        if self.score_history:
            team_count = len(self.teams)
            if any(len(entry.scores) != team_count for entry in self.score_history):
                raise ValueError("score history must contain one score per team")
            if self.score_history[-1].scores != [team.score for team in self.teams]:
                raise ValueError("score history must end at the current scores")
        elif self.teams:
            raise ValueError("a session with teams requires score history")
        return self

    @classmethod
    def empty(cls, instance_name: str) -> QuizSession:
        return cls(instance_name=instance_name)
