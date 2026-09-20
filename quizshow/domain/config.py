"""Backend validation for quiz configuration files."""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Image(ConfigModel):
    src: str
    alt: str

    @field_validator("src")
    @classmethod
    def safe_source(cls, value: str) -> str:
        clean = value.replace("\\", "/")
        if not clean.startswith("assets/") or ".." in clean.split("/") or ":" in clean:
            raise ValueError("media must be inside assets")
        return clean


class Audio(ConfigModel):
    src: str
    label: str

    @field_validator("src")
    @classmethod
    def safe_source(cls, value: str) -> str:
        return Image.safe_source(value)


class TeamConfig(ConfigModel):
    name: str = Field(min_length=1)
    starting_score: int = Field(alias="startingScore")


class JeopardyQuestion(ConfigModel):
    question: str | None = None
    question_image: Image | None = Field(default=None, alias="questionImage")
    question_audio: Audio | None = Field(default=None, alias="questionAudio")
    answer: str | None = None
    answer_image: Image | None = Field(default=None, alias="answerImage")
    answer_audio: Audio | None = Field(default=None, alias="answerAudio")

    @model_validator(mode="after")
    def require_both_sides(self) -> JeopardyQuestion:
        if not any((self.question and self.question.strip(), self.question_image, self.question_audio)):
            raise ValueError("a question medium is required")
        if not any((self.answer and self.answer.strip(), self.answer_image, self.answer_audio)):
            raise ValueError("an answer medium is required")
        return self


class JeopardyCategory(ConfigModel):
    name: str = Field(min_length=1)
    questions: list[JeopardyQuestion] = Field(min_length=1)
    review_question_after_answer: bool = Field(default=False, alias="reviewQuestionAfterAnswer")


class JeopardyConfig(ConfigModel):
    values: list[Annotated[int, Field(gt=0)]] = Field(min_length=1)
    categories: list[JeopardyCategory] = Field(min_length=1)

    @model_validator(mode="after")
    def matching_grid(self) -> JeopardyConfig:
        if any(len(category.questions) != len(self.values) for category in self.categories):
            raise ValueError("each category needs one question per value")
        return self


class QuestionWithId(ConfigModel):
    id: str

    @field_validator("id")
    @classmethod
    def safe_id(cls, value: str) -> str:
        if not ID_PATTERN.fullmatch(value):
            raise ValueError("question id is invalid")
        return value


class OrderingQuestion(QuestionWithId):
    title: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    time_limit_seconds: int = Field(gt=0, alias="timeLimitSeconds")
    items: list[str] = Field(min_length=3, max_length=7)
    item_maps: dict[str, Image] | None = Field(default=None, alias="itemMaps")

    @model_validator(mode="after")
    def unique_known_items(self) -> OrderingQuestion:
        normalized = [item.strip().casefold() for item in self.items]
        if any(not item for item in normalized) or len(normalized) != len(set(normalized)):
            raise ValueError("ordering items must be non-empty and unique")
        if self.item_maps and set(self.item_maps) - set(self.items):
            raise ValueError("itemMaps contains an unknown item")
        return self


class OrderingConfig(ConfigModel):
    scoring_mode: Literal["relative", "exact"] = Field(default="relative", alias="scoringMode")
    points_per_correct: int = Field(gt=0, alias="pointsPerCorrect")
    questions: list[OrderingQuestion] = Field(min_length=1)


class ListingQuestion(QuestionWithId):
    title: str = Field(min_length=1)
    display_category: str = Field(min_length=1, alias="displayCategory")
    prompt: str = Field(min_length=1)
    validation_rule: str = Field(min_length=1, alias="validationRule")
    time_limit_seconds: int = Field(gt=0, alias="timeLimitSeconds")
    max_items: int = Field(ge=1, le=50, alias="maxItems")
    placement_points: list[Annotated[int, Field(ge=0)]] = Field(min_length=1, alias="placementPoints")


class ListingConfig(ConfigModel):
    questions: list[ListingQuestion] = Field(min_length=1)


class SyncQuestion(QuestionWithId):
    prompt: str = Field(min_length=1)


class SyncConfig(ConfigModel):
    time_limit_seconds: int = Field(gt=0, alias="timeLimitSeconds")
    points_per_sync: int = Field(gt=0, alias="pointsPerSync")
    questions: list[SyncQuestion] = Field(min_length=1)


class Games(ConfigModel):
    jeopardy: JeopardyConfig | None = None
    ordering: OrderingConfig | None = None
    listing: ListingConfig | None = None
    sync: SyncConfig | None = None

    @model_validator(mode="after")
    def at_least_one_game_and_unique_ids(self) -> Games:
        configured = [game for game in (self.jeopardy, self.ordering, self.listing, self.sync) if game is not None]
        if not configured:
            raise ValueError("at least one game is required")
        for game in (self.ordering, self.listing, self.sync):
            if game is None:
                continue
            identifiers = [question.id.casefold() for question in game.questions]
            if len(identifiers) != len(set(identifiers)):
                raise ValueError("question ids must be unique within a game")
        return self


class QuizConfig(ConfigModel):
    title: str = Field(min_length=1)
    teams: list[TeamConfig] = Field(min_length=1)
    games: Games

    @model_validator(mode="after")
    def unique_teams(self) -> QuizConfig:
        names = [team.name.strip().casefold() for team in self.teams]
        if any(not name for name in names) or len(names) != len(set(names)):
            raise ValueError("team names must be non-empty and unique")
        return self
