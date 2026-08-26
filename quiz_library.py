"""Discovery and isolated persistence for named quiz save slots."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


class QuizLibrary:
    SLOT_VERSION = 1
    MAX_NAME_LENGTH = 60
    CONFIG_PATTERN = re.compile(r"^[^./\\][^/\\?#%:]*\.json$", re.IGNORECASE)

    def __init__(self, config_directory: Path, save_directory: Path) -> None:
        self.config_directory = config_directory.resolve()
        self.save_directory = save_directory.resolve()
        self.active_file = self.save_directory / "active.json"
        self.lock = threading.RLock()
        self.config_directory.mkdir(parents=True, exist_ok=True)
        self.save_directory.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _timestamp(path: Path) -> str:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()

    @staticmethod
    def _write_json(path: Path, value: dict) -> None:
        encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        temporary = path.with_name(f".{path.name}.tmp")
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    def _config_path(self, config_id: object) -> Path:
        if not isinstance(config_id, str) or not self.CONFIG_PATTERN.fullmatch(config_id):
            raise ValueError("Die Quizkonfiguration ist ungültig.")
        path = (self.config_directory / config_id).resolve()
        if path.parent != self.config_directory or not path.is_file() or path.is_symlink():
            raise ValueError("Die Quizkonfiguration existiert nicht.")
        return path

    def configurations(self) -> list[dict]:
        with self.lock:
            result = []
            for path in sorted(self.config_directory.glob("*.json"), key=lambda item: item.name.casefold()):
                try:
                    resolved = path.resolve()
                except OSError:
                    continue
                if (not path.is_file() or path.is_symlink() or resolved.parent != self.config_directory
                        or not self.CONFIG_PATTERN.fullmatch(path.name)):
                    continue
                result.append({"id": path.name, "url": f"/quizzes/{quote(path.name)}"})
            return result

    def _slot_directory(self, slot_id: object, must_exist: bool = True) -> Path:
        if not isinstance(slot_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", slot_id):
            raise ValueError("Der Spielstand ist ungültig.")
        path = (self.save_directory / slot_id).resolve()
        if path.parent != self.save_directory or (must_exist and not path.is_dir()):
            raise ValueError("Der Spielstand existiert nicht.")
        return path

    def _read_slot(self, directory: Path) -> dict:
        metadata_file = directory / "slot.json"
        try:
            value = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("Die Spielstand-Metadaten sind ungültig.") from error
        if (not isinstance(value, dict) or value.get("version") != self.SLOT_VERSION
                or value.get("id") != directory.name or not isinstance(value.get("name"), str)
                or not isinstance(value.get("configId"), str) or not isinstance(value.get("createdAt"), str)):
            raise ValueError("Die Spielstand-Metadaten sind ungültig.")
        files = [item for item in directory.iterdir() if item.is_file() and not item.name.startswith(".")]
        newest = max(files, key=lambda item: item.stat().st_mtime, default=metadata_file)
        return {
            "id": value["id"], "name": value["name"], "configId": value["configId"],
            "createdAt": value["createdAt"], "updatedAt": self._timestamp(newest),
            "hasState": (directory / "game-state.json").is_file(),
            "configAvailable": any(item["id"] == value["configId"] for item in self.configurations()),
        }

    def slots(self) -> list[dict]:
        with self.lock:
            result = []
            for directory in self.save_directory.iterdir():
                if not directory.is_dir() or directory.is_symlink():
                    continue
                try:
                    result.append(self._read_slot(directory))
                except ValueError:
                    continue
            return sorted(result, key=lambda item: (item["configId"].casefold(), item["name"].casefold()))

    def active_slot_id(self) -> str | None:
        with self.lock:
            try:
                value = json.loads(self.active_file.read_text(encoding="utf-8"))
                slot_id = value.get("slotId")
                self._slot_directory(slot_id)
                return slot_id
            except (OSError, UnicodeError, json.JSONDecodeError, AttributeError, ValueError):
                return None

    def snapshot(self) -> dict:
        return {
            "version": 1,
            "configurations": self.configurations(),
            "slots": self.slots(),
            "activeSlotId": self.active_slot_id(),
        }

    def _clean_name(self, name: object) -> str:
        if not isinstance(name, str):
            raise ValueError("Ein Name für den Spielstand ist erforderlich.")
        clean = " ".join(name.split())
        if not clean or len(clean) > self.MAX_NAME_LENGTH:
            raise ValueError(f"Der Name muss 1 bis {self.MAX_NAME_LENGTH} Zeichen enthalten.")
        return clean

    def _ensure_unique_name(self, name: str, config_id: str, excluding: str | None = None) -> None:
        if any(slot["id"] != excluding and slot["configId"] == config_id
               and slot["name"].casefold() == name.casefold() for slot in self.slots()):
            raise ValueError("Für dieses Quiz existiert bereits ein Spielstand mit diesem Namen.")

    def create(self, name: object, config_id: object) -> str:
        with self.lock:
            clean_name = self._clean_name(name)
            config_path = self._config_path(config_id)
            self._ensure_unique_name(clean_name, config_path.name)
            slot_id = secrets.token_urlsafe(12).replace("-", "_")
            directory = self._slot_directory(slot_id, False)
            directory.mkdir()
            now = datetime.now(timezone.utc).isoformat()
            self._write_json(directory / "slot.json", {
                "version": self.SLOT_VERSION, "id": slot_id, "name": clean_name,
                "configId": config_path.name, "createdAt": now,
            })
            self.activate(slot_id)
            return slot_id

    def activate(self, slot_id: object) -> str:
        with self.lock:
            directory = self._slot_directory(slot_id)
            metadata = self._read_slot(directory)
            if not metadata["configAvailable"]:
                raise ValueError("Die Quizkonfiguration dieses Spielstands fehlt.")
            self._write_json(self.active_file, {"version": 1, "slotId": directory.name})
            return directory.name

    def rename(self, slot_id: object, name: object) -> None:
        with self.lock:
            directory = self._slot_directory(slot_id)
            metadata = self._read_slot(directory)
            clean_name = self._clean_name(name)
            self._ensure_unique_name(clean_name, metadata["configId"], directory.name)
            original = json.loads((directory / "slot.json").read_text(encoding="utf-8"))
            original["name"] = clean_name
            self._write_json(directory / "slot.json", original)

    def delete(self, slot_id: object) -> bool:
        with self.lock:
            directory = self._slot_directory(slot_id)
            was_active = self.active_slot_id() == directory.name
            shutil.rmtree(directory)
            if was_active:
                self.active_file.unlink(missing_ok=True)
            return was_active

    def active_directory(self) -> Path | None:
        slot_id = self.active_slot_id()
        return self._slot_directory(slot_id) if slot_id else None

    def active_config_url(self) -> str | None:
        directory = self.active_directory()
        if directory is None:
            return None
        metadata = self._read_slot(directory)
        return f"/quizzes/{quote(metadata['configId'])}" if metadata["configAvailable"] else None

    def active_state_path(self, filename: str) -> Path | None:
        directory = self.active_directory()
        return directory / filename if directory else None
