"""Typed commands and pure state transitions for the quiz session."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .session import GAME_IDS, HostScreen, QuizSession, ScoreHistoryEntry, SessionPhase, Team


class CommandModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartSession(CommandModel):
    type: Literal["start-session"]
    teams: list[Team]


class Navigate(CommandModel):
    type: Literal["navigate"]
    screen: HostScreen


class SetRoundPhase(CommandModel):
    type: Literal["set-round-phase"]
    game: Literal["jeopardy", "ordering", "listing", "sync"]
    phase: SessionPhase
    deadline_at: float | None = None


class AdjustScore(CommandModel):
    type: Literal["adjust-score"]
    team_index: int = Field(ge=0)
    amount: int
    game: Literal["jeopardy", "ordering", "listing", "sync"] | None = None
    award_id: str | None = Field(default=None, min_length=1)


class MarkRulesShown(CommandModel):
    type: Literal["mark-rules-shown"]
    game: Literal["jeopardy", "ordering", "listing", "sync"]


class ReplaceGameState(CommandModel):
    """Compatibility command used while legacy game services are migrated."""

    type: Literal["replace-game-state"]
    game: Literal["jeopardy", "ordering", "listing", "sync"]
    state: dict[str, Any]


class SetPresentation(CommandModel):
    type: Literal["set-presentation"]
    presentation: dict[str, Any]


Command = Annotated[
    StartSession | Navigate | SetRoundPhase | AdjustScore | MarkRulesShown | ReplaceGameState | SetPresentation,
    Field(discriminator="type"),
]


def apply_command(session: QuizSession, command: CommandModel, now: float) -> QuizSession:
    """Return a validated next state without mutating the supplied session."""
    next_session = session.model_copy(deep=True)

    if isinstance(command, StartSession):
        if not command.teams:
            raise ValueError("at least one team is required")
        next_session.teams = [team.model_copy(deep=True) for team in command.teams]
        next_session.score_history = [ScoreHistoryEntry(scores=[team.score for team in command.teams])]
        next_session.game_started = True
        next_session.screen = HostScreen.HUB
        next_session.phase = SessionPhase.IDLE
    elif isinstance(command, Navigate):
        if command.screen not in {HostScreen.START, HostScreen.SETUP} and not next_session.game_started:
            raise ValueError("the quiz must be started before navigating to this screen")
        next_session.screen = command.screen
        next_session.active_game = command.screen.value if command.screen.value in GAME_IDS else None
    elif isinstance(command, SetRoundPhase):
        if not next_session.game_started:
            raise ValueError("the quiz has not started")
        if command.phase == SessionPhase.ACTIVE and command.deadline_at is not None and command.deadline_at <= now:
            raise ValueError("an active round deadline must be in the future")
        next_session.active_game = command.game
        next_session.screen = HostScreen(command.game)
        next_session.phase = command.phase
        if command.deadline_at is None:
            next_session.timer_deadlines.pop(command.game, None)
        else:
            next_session.timer_deadlines[command.game] = command.deadline_at
    elif isinstance(command, AdjustScore):
        if command.team_index >= len(next_session.teams):
            raise ValueError("unknown team")
        if command.award_id and command.award_id in next_session.applied_awards:
            raise ValueError("this award was already applied")
        next_session.teams[command.team_index].score += command.amount
        if command.award_id:
            next_session.applied_awards.add(command.award_id)
        next_session.score_history.append(ScoreHistoryEntry(
            scores=[team.score for team in next_session.teams], game=command.game,
        ))
    elif isinstance(command, MarkRulesShown):
        next_session.shown_rule_game_ids.add(command.game)
    elif isinstance(command, ReplaceGameState):
        next_session.games[command.game] = command.state.copy()
    elif isinstance(command, SetPresentation):
        next_session.presentation = command.presentation.copy()
    else:  # pragma: no cover - the discriminated command union prevents this
        raise TypeError("unsupported command")

    next_session.revision += 1
    next_session.updated_at = datetime.fromtimestamp(now, UTC)
    return QuizSession.model_validate(next_session.model_dump())
