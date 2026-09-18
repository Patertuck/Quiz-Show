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
        self._connections: dict[str, Any] = {}
        self._lock = asyncio.Lock()

    async def add(self, connection_id: str, connection: Any) -> None:
        async with self._lock:
            self._connections[connection_id] = connection

    async def remove(self, connection_id: str) -> None:
        async with self._lock:
            self._connections.pop(connection_id, None)

    async def ids(self) -> tuple[str, ...]:
        async with self._lock:
            return tuple(sorted(self._connections))

    async def close_all(self) -> None:
        async with self._lock:
            connections = tuple(self._connections.values())
            self._connections.clear()
        for connection in connections:
            close = getattr(connection, "close", None)
            if close is None:
                continue
            result = close()
            if hasattr(result, "__await__"):
                await result


@dataclass(slots=True)
class ExportService:
    """Own synchronization for final exports until export logic is migrated."""

    lock: threading.Lock = field(default_factory=threading.Lock)

