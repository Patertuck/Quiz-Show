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
FINAL_EXPORT_GAME_IDS = frozenset(FINAL_EXPORT_GAME_LABELS)


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


def _export_game_ids(payload: dict) -> list[str]:
    game_ids = payload.get("gameIds")
    if (not isinstance(game_ids, list) or not game_ids or len(game_ids) != len(set(game_ids))
            or any(game not in FINAL_EXPORT_GAME_IDS for game in game_ids)):
        raise ValueError("gameIds ist ungültig.")
    return game_ids


def final_export_key(state: dict, game_ids: list[str] | None = None) -> str:
    identity = {
        "formatVersion": 4,
        "teams": state["teams"],
        "scoreHistory": state["scoreHistory"],
        "analyticsEvents": state.get("analyticsEvents", []),
        "gameIds": game_ids or [],
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


def _leaders(scores: list[int]) -> set[int]:
    maximum = max(scores)
    return {index for index, score in enumerate(scores) if score == maximum}


def final_statistics(state: dict, game_ids: list[str]) -> dict:
    teams = state["teams"]
    history = state["scoreHistory"]
    team_count = len(teams)
    gross = [0] * team_count
    biggest = [0] * team_count
    biggest_games: list[str | None] = [None] * team_count
    game_totals = {game: [0] * team_count for game in game_ids}
    active_games: set[str] = set()
    other = [0] * team_count
    lead_changes = 0
    previous_leaders = _leaders(history[0]["scores"])
    for previous, entry in zip(history, history[1:]):
        game = entry.get("game") if entry.get("game") in FINAL_EXPORT_GAME_IDS else None
        if game:
            game_totals.setdefault(game, [0] * team_count)
            active_games.add(game)
        for index, (old_score, score) in enumerate(zip(previous["scores"], entry["scores"])):
            change = score - old_score
            if change > 0:
                gross[index] += change
            if change > biggest[index]:
                biggest[index] = change
                biggest_games[index] = game
            (game_totals[game] if game else other)[index] += change
        current_leaders = _leaders(entry["scores"])
        if current_leaders != previous_leaders:
            lead_changes += 1
        previous_leaders = current_leaders

    start_scores = history[0]["scores"]
    maximum_deficits = [max(start_scores) - score for score in start_scores]
    comebacks = [0] * team_count
    for entry in history[1:]:
        leader = max(entry["scores"])
        for index, score in enumerate(entry["scores"]):
            deficit = leader - score
            comebacks[index] = max(comebacks[index], maximum_deficits[index] - deficit)
            maximum_deficits[index] = max(maximum_deficits[index], deficit)
    game_wins = [0] * team_count
    for game in active_games:
        maximum = max(game_totals[game])
        for index, value in enumerate(game_totals[game]):
            if value == maximum:
                game_wins[index] += 1

    final_scores = [team["score"] for team in teams]
    distinct_scores = sorted(set(final_scores), reverse=True)
    ranks = [1 + sum(1 for candidate in final_scores if candidate > score) for score in final_scores]
    summary_values = {game: game_totals[game] for game in game_ids}
    if any(other):
        summary_values["other"] = other
    summary_nets = {game: sum(values) for game, values in summary_values.items()}
    total_magnitude = sum(abs(value) for value in summary_nets.values())
    game_summaries = {
        game: {
            "netPoints": summary_nets[game],
            "percentage": abs(summary_nets[game]) / total_magnitude * 100 if total_magnitude else 0.0,
            "spread": max(values) - min(values) if values else 0,
        }
        for game, values in summary_values.items()
    }
    return {
        "leadChanges": lead_changes,
        "winnerMargin": distinct_scores[0] - distinct_scores[1] if len(distinct_scores) > 1 else 0,
        "winnerIndices": sorted(_leaders(final_scores)),
        "gross": gross, "biggest": biggest, "biggestGames": biggest_games,
        "comebacks": comebacks, "gameWins": game_wins, "gameTotals": game_totals,
        "other": other, "ranks": ranks, "gameSummaries": game_summaries,
    }


def final_statistics_csv(state: dict, game_ids: list[str], highlight_slides: list[dict] | None = None) -> bytes:
    stats = final_statistics(state, game_ids)
    teams = state["teams"]
    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter=";", lineterminator="\n")
    writer.writerow(["Typ", "Kennzahl", "Team", "Spiel", "Wert"])
    winners = " & ".join(teams[index]["name"] for index in stats["winnerIndices"])
    writer.writerow(["Quiz", "Führungswechsel", "", "", stats["leadChanges"]])
    writer.writerow(["Quiz", "Siegervorsprung", winners, "", stats["winnerMargin"]])
    for game, summary in stats["gameSummaries"].items():
        label = FINAL_EXPORT_GAME_LABELS.get(game, "Sonstiges")
        writer.writerow(["Spielübersicht", "Nettopunkte", "", label, summary["netPoints"]])
        writer.writerow(["Spielübersicht", "Anteil Prozent", "", label, f"{summary['percentage']:.1f}"])
        writer.writerow(["Spielübersicht", "Spanne", "", label, summary["spread"]])
    maximums = {
        "Stärkstes Comeback": max(stats["comebacks"], default=0),
        "Punktesammler": max(stats["gross"], default=0),
        "Meiste Spielsiege": max(stats["gameWins"], default=0),
    }
    sources = {
        "Stärkstes Comeback": stats["comebacks"],
        "Punktesammler": stats["gross"], "Meiste Spielsiege": stats["gameWins"],
    }
    for label, maximum in maximums.items():
        if maximum <= 0:
            continue
        names = " & ".join(teams[index]["name"] for index, value in enumerate(sources[label]) if value == maximum)
        writer.writerow(["Auszeichnung", label, names, "", maximum])
    start_scores = state["scoreHistory"][0]["scores"]
    for index, team in enumerate(teams):
        for label, value in (
            ("Platz", stats["ranks"][index]), ("Endstand", team["score"]),
            ("Gesamtveränderung", team["score"] - start_scores[index]),
            ("Positive Punkte", stats["gross"][index]),
            ("Stärkstes Comeback", stats["comebacks"][index]), ("Spielsiege", stats["gameWins"][index]),
        ):
            writer.writerow(["Team", label, team["name"], "", value])
        for game in game_ids:
            writer.writerow(["Spiel", "Netto-Punkte", team["name"], FINAL_EXPORT_GAME_LABELS[game], stats["gameTotals"][game][index]])
        if stats["other"][index]:
            writer.writerow(["Spiel", "Netto-Punkte", team["name"], "Sonstiges", stats["other"][index]])
    for slide in highlight_slides or []:
        for card in slide["cards"]:
            writer.writerow(["Highlight", slide["title"], card["names"], card["title"], card["value"]])
    return output.getvalue().encode("utf-8-sig")


def _highlight_slides(payload: dict) -> list[dict]:
    slides = payload.get("highlightSlides")
    if not isinstance(slides, list) or len(slides) != 2:
        raise ValueError("highlightSlides ist ungültig.")
    clean = []
    for slide in slides:
        if not isinstance(slide, dict) or slide.get("id") not in {"team-awards", "quiz-records"} or not isinstance(slide.get("title"), str):
            raise ValueError("highlightSlides ist ungültig.")
        cards = slide.get("cards")
        if not isinstance(cards, list) or len(cards) != 6:
            raise ValueError("highlightSlides ist ungültig.")
        clean_cards = []
        for card in cards:
            fields = ("title", "names", "value", "detail")
            if not isinstance(card, dict) or any(not isinstance(card.get(field, ""), str) for field in fields):
                raise ValueError("highlightSlides ist ungültig.")
            clean_cards.append({field: card.get(field, "")[:300] for field in fields})
        clean.append({"id": slide["id"], "title": slide["title"][:100], "cards": clean_cards})
    if {slide["id"] for slide in clean} != {"team-awards", "quiz-records"}:
        raise ValueError("highlightSlides ist ungültig.")
    return clean


def save_final_export(payload: dict, state: dict, directory: Path) -> tuple[Path, bool]:
    podium = _decode_export_png(payload.get("podiumPng"), "podiumPng")
    score_history = _decode_export_png(payload.get("scoreHistoryPng"), "scoreHistoryPng")
    team_awards = _decode_export_png(payload.get("teamAwardsPng"), "teamAwardsPng")
    quiz_records = _decode_export_png(payload.get("quizRecordsPng"), "quizRecordsPng")
    game_breakdown = _decode_export_png(payload.get("gameBreakdownPng"), "gameBreakdownPng")
    game_ids = _export_game_ids(payload)
    highlight_slides = _highlight_slides(payload)
    export_key = final_export_key(state, game_ids)
    csv_bytes = final_export_csv(state)
    statistics_csv_bytes = final_statistics_csv(state, game_ids, highlight_slides)
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
            (temporary / "team-awards.png").write_bytes(team_awards)
            (temporary / "quiz-rekorde.png").write_bytes(quiz_records)
            (temporary / "spielvergleich.png").write_bytes(game_breakdown)
            (temporary / "punkteverlauf.csv").write_bytes(csv_bytes)
            (temporary / "statistiken.csv").write_bytes(statistics_csv_bytes)
            os.replace(temporary, target)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
    return target, True

