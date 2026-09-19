"""Small infrastructure services shared by application components."""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Protocol


class Clock(Protocol):
    def now(self) -> float: ...


class SystemClock:
    def now(self) -> float:
        return time.time()


class ConnectionRegistry:
    """Track live connections without coupling the container to a transport."""

    def __init__(self) -> None:
        self._connections: dict[str, tuple[Any, str, str | None, int | None]] = {}
        self._lock = asyncio.Lock()

    async def add(self, connection_id: str, connection: Any, *, role: str = "public",
                  device_id: str | None = None, team_index: int | None = None) -> None:
        async with self._lock:
            self._connections[connection_id] = (connection, role, device_id, team_index)

    async def remove(self, connection_id: str) -> None:
        async with self._lock:
            self._connections.pop(connection_id, None)

    async def ids(self) -> tuple[str, ...]:
        async with self._lock:
            return tuple(sorted(self._connections))

    async def close_all(self) -> None:
        async with self._lock:
            connections = tuple(item[0] for item in self._connections.values())
            self._connections.clear()
        for connection in connections:
            close = getattr(connection, "close", None)
            if close is None:
                continue
            result = close()
            if hasattr(result, "__await__"):
                await result

    async def broadcast(self, snapshot_factory) -> None:
        async with self._lock:
            clients = tuple(self._connections.items())
        stale = []
        for connection_id, (connection, role, device_id, team_index) in clients:
            try:
                await connection.send_json({
                    "type": "snapshot",
                    "data": snapshot_factory(role, device_id, team_index),
                })
            except Exception:
                stale.append(connection_id)
        if stale:
            async with self._lock:
                for connection_id in stale:
                    self._connections.pop(connection_id, None)


@dataclass(slots=True)
class ExportService:
    """Own synchronization for final exports until export logic is migrated."""

    lock: threading.Lock = field(default_factory=threading.Lock)
