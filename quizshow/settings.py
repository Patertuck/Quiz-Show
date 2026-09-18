"""Runtime settings and filesystem locations for the quiz server."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    project_directory: Path
    bind_host: str = "0.0.0.0"
    port: int = 8000

    def __post_init__(self) -> None:
        object.__setattr__(self, "project_directory", self.project_directory.resolve())
        if not 1 <= self.port <= 65535:
            raise ValueError("port must be between 1 and 65535")

    @classmethod
    def from_project_root(cls) -> "Settings":
        return cls(Path(__file__).resolve().parent.parent)

    @property
    def quiz_data_directory(self) -> Path:
        return self.project_directory / "quiz-data"

    @property
    def variation_directory(self) -> Path:
        return self.quiz_data_directory / "variations"

    @property
    def instance_directory(self) -> Path:
        return self.quiz_data_directory / "instances"

    @property
    def logo_directory(self) -> Path:
        return self.project_directory / "assets" / "Logos"

