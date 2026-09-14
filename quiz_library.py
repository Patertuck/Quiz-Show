"""Discovery and persistence for quiz variations and named quiz instances."""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


class QuizLibrary:
    INSTANCE_VERSION = 1
    MAX_NAME_LENGTH = 60
    NAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
    CONFIG_FILENAME = "quiz-config.json"

    def __init__(self, variation_directory: Path, instance_directory: Path) -> None:
        self.variation_directory = variation_directory.resolve()
        self.instance_directory = instance_directory.resolve()
        self.lock = threading.RLock()
        self._active_instance_name: str | None = None
        self.variation_directory.mkdir(parents=True, exist_ok=True)
        self.instance_directory.mkdir(parents=True, exist_ok=True)

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

    def _name(self, value: object, kind: str) -> str:
        if (not isinstance(value, str) or len(value) > self.MAX_NAME_LENGTH
                or not self.NAME_PATTERN.fullmatch(value)):
            raise ValueError(
                f"Der {kind}name muss 1 bis {self.MAX_NAME_LENGTH} Zeichen lang sein "
                "und darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten."
            )
        return value

    def _variation_config(self, variation_id: object) -> Path:
        name = self._name(variation_id, "Variations")
        package = self.variation_directory / name
        config = package / self.CONFIG_FILENAME
        if (not package.is_dir() or package.is_symlink() or not config.is_file() or config.is_symlink()
                or package.resolve().parent != self.variation_directory):
            raise ValueError("Die Quiz-Variante existiert nicht.")
        return config.resolve()

    def variations(self) -> list[dict]:
        with self.lock:
            result = []
            for package in sorted(self.variation_directory.iterdir(), key=lambda item: item.name):
                try:
                    self._variation_config(package.name)
                except (OSError, ValueError):
                    continue
                result.append({
                    "id": package.name,
                    "url": f"/quiz-content/{quote(package.name)}/{self.CONFIG_FILENAME}",
                })
            return result

    def content_path(self, request_path: str) -> tuple[Path, str] | None:
        """Resolve a variation config or asset URL without exposing other quiz data."""
        decoded = unquote(urlsplit(request_path).path)
        parts = decoded.strip("/").split("/")
        if len(parts) < 3 or parts[0] != "quiz-content":
            return None
        try:
            config = self._variation_config(parts[1])
        except ValueError:
            return None
        if parts[2:] == [self.CONFIG_FILENAME]:
            return config, "config"
        if parts[2] != "assets" or len(parts) < 4 or any(part in {"", ".", ".."} for part in parts[3:]):
            return None
        asset_root = config.parent / "assets"
        try:
            asset_root_resolved = asset_root.resolve(strict=True)
            asset_root_resolved.relative_to(config.parent.resolve())
            resolved = asset_root_resolved.joinpath(*parts[3:]).resolve(strict=True)
            resolved.relative_to(asset_root_resolved)
        except (OSError, ValueError):
            return None
        return (resolved, "asset") if resolved.is_file() else None

    def _instance_path(self, name: object, must_exist: bool = True) -> Path:
        clean = self._name(name, "Instanz")
        path = self.instance_directory / clean
        if path.resolve().parent != self.instance_directory or path.is_symlink():
            raise ValueError("Die Quiz-Instanz ist ungültig.")
        if must_exist and not path.is_dir():
            raise ValueError("Die Quiz-Instanz existiert nicht.")
        return path

    def _read_instance(self, directory: Path) -> dict:
        metadata_file = directory / "instance.json"
        try:
            value = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("Die Instanz-Metadaten sind ungültig.") from error
        if (not isinstance(value, dict) or value.get("version") != self.INSTANCE_VERSION
                or not isinstance(value.get("variationId"), str)
                or not isinstance(value.get("createdAt"), str)):
            raise ValueError("Die Instanz-Metadaten sind ungültig.")
        files = [item for item in directory.rglob("*") if item.is_file() and not item.name.startswith(".")]
        newest = max(files, key=lambda item: item.stat().st_mtime, default=metadata_file)
        results = directory / "results"
        return {
            "name": directory.name,
            "variationId": value["variationId"],
            "createdAt": value["createdAt"],
            "updatedAt": self._timestamp(newest),
            "hasState": (directory / "game-state.json").is_file(),
            "hasResults": results.is_dir() and any(item.is_file() for item in results.rglob("*")),
            "variationAvailable": any(item["id"] == value["variationId"] for item in self.variations()),
        }

    def instances(self) -> list[dict]:
        with self.lock:
            result = []
            for directory in self.instance_directory.iterdir():
                if not directory.is_dir() or directory.is_symlink():
                    continue
                try:
                    self._name(directory.name, "Instanz")
                    result.append(self._read_instance(directory))
                except ValueError:
                    continue
            return sorted(result, key=lambda item: (item["variationId"], item["name"]))

    def active_instance_name(self) -> str | None:
        with self.lock:
            if self._active_instance_name is None:
                return None
            try:
                self._instance_path(self._active_instance_name)
            except ValueError:
                self._active_instance_name = None
            return self._active_instance_name

    def snapshot(self) -> dict:
        return {
            "version": 2,
            "variations": self.variations(),
            "instances": self.instances(),
            "activeInstanceName": self.active_instance_name(),
        }

    def create(self, name: object, variation_id: object) -> str:
        with self.lock:
            clean = self._name(name, "Instanz")
            config = self._variation_config(variation_id)
            directory = self._instance_path(clean, False)
            if directory.exists():
                raise ValueError("Eine Quiz-Instanz mit diesem Namen existiert bereits.")
            directory.mkdir()
            try:
                self._write_json(directory / "instance.json", {
                    "version": self.INSTANCE_VERSION,
                    "variationId": config.parent.name,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                directory.rmdir()
                raise
            self._active_instance_name = clean
            return clean

    def activate(self, name: object) -> str:
        with self.lock:
            directory = self._instance_path(name)
            metadata = self._read_instance(directory)
            if not metadata["variationAvailable"]:
                raise ValueError("Die Quiz-Variante dieser Instanz fehlt.")
            self._active_instance_name = directory.name
            return directory.name

    def rename(self, name: object, new_name: object) -> str:
        with self.lock:
            source = self._instance_path(name)
            clean = self._name(new_name, "Instanz")
            if clean == source.name:
                return clean
            target = self._instance_path(clean, False)
            if target.exists():
                raise ValueError("Eine Quiz-Instanz mit diesem Namen existiert bereits.")
            os.replace(source, target)
            if self._active_instance_name == source.name:
                self._active_instance_name = clean
            return clean

    def delete(self, name: object) -> bool:
        with self.lock:
            directory = self._instance_path(name)
            was_active = self._active_instance_name == directory.name
            shutil.rmtree(directory)
            if was_active:
                self._active_instance_name = None
            return was_active

    def active_directory(self) -> Path | None:
        name = self.active_instance_name()
        return self._instance_path(name) if name else None

    def active_config_url(self) -> str | None:
        directory = self.active_directory()
        if directory is None:
            return None
        metadata = self._read_instance(directory)
        return (f"/quiz-content/{quote(metadata['variationId'])}/{self.CONFIG_FILENAME}"
                if metadata["variationAvailable"] else None)

    def active_state_path(self, filename: str) -> Path | None:
        directory = self.active_directory()
        if directory is None:
            return None
        path = directory / filename
        if path.is_symlink():
            raise ValueError("Der Instanz-Spielstand darf kein symbolischer Link sein.")
        return path

    def active_results_directory(self) -> Path | None:
        directory = self.active_directory()
        if directory is None:
            return None
        results = directory / "results"
        if results.is_symlink():
            return None
        return results
