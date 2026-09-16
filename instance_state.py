"""Atomic, section-based persistence for one active quiz instance."""

from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path


class InstanceStateStore:
    VERSION = 1
    SECTIONS = ("game", "ordering", "listing", "sync")

    def __init__(self, path: Path | None = None) -> None:
        self.lock = threading.RLock()
        self.path: Path | None = None
        self.data = self._empty()
        self.switch(path)

    @classmethod
    def _empty(cls) -> dict:
        return {"version": cls.VERSION, **{name: None for name in cls.SECTIONS}}

    @classmethod
    def load_file(cls, path: Path) -> dict:
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("Der zusammengeführte Spielstand ist keine gültige JSON-Datei.") from error
        if not isinstance(value, dict) or value.get("version") != cls.VERSION:
            raise ValueError("Der zusammengeführte Spielstand hat eine ungültige Version.")
        unknown = set(value) - {"version", *cls.SECTIONS}
        if unknown or any(name not in value for name in cls.SECTIONS):
            raise ValueError("Der zusammengeführte Spielstand hat ungültige Abschnitte.")
        if any(value[name] is not None and not isinstance(value[name], dict) for name in cls.SECTIONS):
            raise ValueError("Jeder Spielstand-Abschnitt muss ein Objekt oder null sein.")
        return value

    def switch(self, path: Path | None) -> None:
        with self.lock:
            data = self._empty() if path is None or not path.exists() else self.load_file(path)
            self.path = path
            self.data = data

    def read(self, section: str) -> dict | None:
        if section not in self.SECTIONS:
            raise ValueError("Unbekannter Spielstand-Abschnitt.")
        with self.lock:
            return copy.deepcopy(self.data[section])

    def _save_unlocked(self) -> None:
        if self.path is None:
            raise ValueError("Es ist keine Quiz-Instanz ausgewählt.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.tmp")
        encoded = (json.dumps(self.data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)

    def write(self, section: str, value: dict | None) -> None:
        if section not in self.SECTIONS or (value is not None and not isinstance(value, dict)):
            raise ValueError("Ungültiger Spielstand-Abschnitt.")
        with self.lock:
            previous = self.data[section]
            self.data[section] = copy.deepcopy(value)
            try:
                self._save_unlocked()
            except OSError:
                self.data[section] = previous
                raise

    def write_game(self, value: dict, current_revision: int | None = None) -> bool:
        with self.lock:
            current = self.data["game"]
            if (current_revision is not None and isinstance(current, dict)
                    and current.get("revision", 0) > current_revision):
                return False
            self.data["game"] = copy.deepcopy(value)
            try:
                self._save_unlocked()
            except OSError:
                self.data["game"] = current
                raise
            return True

    def clear(self) -> None:
        with self.lock:
            self.data = self._empty()
            if self.path is not None:
                self.path.unlink(missing_ok=True)
                self.path.with_name(f".{self.path.name}.tmp").unlink(missing_ok=True)
