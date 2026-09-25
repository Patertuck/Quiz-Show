"""Creation of the final, immutable quiz result bundle."""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
import secrets
import shutil
import struct
import threading
from datetime import datetime
from pathlib import Path

MAX_FINAL_EXPORT_PNG_BYTES = 8_000_000
FINAL_EXPORT_LOCK = threading.Lock()

FINAL_EXPORT_GAME_LABELS = {
    "jeopardy": "Jeopardy",
    "ordering": "Order Up",
    "listing": "List It",
    "sync": "Sync Up",
}


def _decode_export_png(value: object, field: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} fehlt.")
    try:
        image = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError(f"{field} ist kein gültiges Base64-PNG.") from error
    if len(image) > MAX_FINAL_EXPORT_PNG_BYTES:
        raise ValueError(f"{field} ist zu gross.")
    if len(image) < 24 or image[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{field} ist keine PNG-Datei.")
    width, height = struct.unpack(">II", image[16:24])
    if (width, height) != (1920, 1080):
        raise ValueError(f"{field} muss 1920 × 1080 Pixel gross sein.")
    return image


def final_export_key(state: dict) -> str:
    identity = {
        "formatVersion": 2,
        "teams": state["teams"],
        "scoreHistory": state["scoreHistory"],
    }
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:12]


def final_export_csv(state: dict) -> bytes:
    teams = state["teams"]
    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter=";", lineterminator="\n")
    header = ["Schritt", "Spiel"]
    for team in teams:
        header.extend([f"{team['name']} – Punktestand", f"{team['name']} – Veränderung"])
    writer.writerow(header)
    previous = None
    for index, entry in enumerate(state["scoreHistory"]):
        game = "Start" if index == 0 else FINAL_EXPORT_GAME_LABELS.get(entry.get("game"), "Frühere Punkte")
        row: list[object] = [index, game]
        for team_index, score in enumerate(entry["scores"]):
            change = 0 if previous is None else score - previous[team_index]
            row.extend([score, change])
        writer.writerow(row)
        previous = entry["scores"]
    return output.getvalue().encode("utf-8-sig")


def save_final_export(payload: dict, state: dict, directory: Path) -> tuple[Path, bool]:
    podium = _decode_export_png(payload.get("podiumPng"), "podiumPng")
    score_history = _decode_export_png(payload.get("scoreHistoryPng"), "scoreHistoryPng")
    export_key = final_export_key(state)
    csv_bytes = final_export_csv(state)
    with FINAL_EXPORT_LOCK:
        directory.mkdir(parents=True, exist_ok=True)
        existing = next((candidate
                         for prefix in ("quizzy", "quizshow")
                         for candidate in directory.glob(f"{prefix}-*_{export_key}")), None)
        if existing is not None and existing.is_dir():
            return existing, False
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        target = directory / f"quizzy-{timestamp}_{export_key}"
        temporary = directory / f".export-{secrets.token_hex(8)}"
        try:
            temporary.mkdir()
            (temporary / "podest.png").write_bytes(podium)
            (temporary / "punkteverlauf.png").write_bytes(score_history)
            (temporary / "punkteverlauf.csv").write_bytes(csv_bytes)
            os.replace(temporary, target)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
    return target, True

