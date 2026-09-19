"""One consistent command and snapshot interface for the live game services."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol


class SnapshotService(Protocol):
    def snapshot(self, *args: Any) -> dict[str, Any]: ...


PlayerOperation = Callable[[dict[str, Any]], tuple[int, dict[str, Any]]]


@dataclass(frozen=True)
class GameServices:
    team_lobby: SnapshotService
    buzzer: SnapshotService
    ordering: SnapshotService
    listing: SnapshotService
    sync: SnapshotService

    def snapshots(self, role: str, device_id: str | None = None,
                  team_index: int | None = None) -> dict[str, dict[str, Any]]:
        if role == "host":
            return {
                "teamLobby": self.team_lobby.snapshot("host", None),
                "buzzer": self.buzzer.snapshot(),
                "ordering": self.ordering.snapshot("host", None),
                "listing": self.listing.snapshot("host", None),
                "sync": self.sync.snapshot("host", None),
            }
        if role == "player":
            return {
                "teamLobby": self.team_lobby.snapshot("player", device_id) if device_id else self.team_lobby.snapshot(),
                "buzzer": self.buzzer.snapshot(),
                "ordering": self.ordering.snapshot("team", team_index) if team_index is not None else self.ordering.snapshot("public", None),
                "listing": self.listing.snapshot("team", team_index) if team_index is not None else self.listing.snapshot("public", None),
                "sync": self.sync.snapshot("player", device_id) if device_id else self.sync.snapshot("public", None),
            }
        return {
            "teamLobby": self.team_lobby.snapshot("public", None),
            "buzzer": self.buzzer.snapshot(),
            "ordering": self.ordering.snapshot("public", None),
            "listing": self.listing.snapshot("public", None),
            "sync": self.sync.snapshot("public", None),
        }

    def execute_player(self, command_type: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        operations: dict[str, PlayerOperation] = {
            "team-lobby": self.team_lobby.player_control,
            "buzz": self.buzzer.buzz,
            "ordering": self.ordering.update_order,
            "listing": self.listing.update_submission,
            "sync-register": self.sync.register,
            "sync-reconnect": self.sync.reconnect,
            "sync-vote": self.sync.vote,
        }
        try:
            operation = operations[command_type]
        except KeyError as error:
            raise ValueError(f"Unknown player command: {command_type}") from error
        return operation(payload)


def legacy_game_services() -> GameServices:
    import main

    return GameServices(
        team_lobby=main.TEAM_LOBBY,
        buzzer=main.BUZZER,
        ordering=main.ORDERING,
        listing=main.LISTING,
        sync=main.SYNC,
    )
