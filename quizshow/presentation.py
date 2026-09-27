"""Presentation validation and in-memory projection state."""

from __future__ import annotations

import re
import secrets
import threading
import time

from quiz_library import LOGO_FILENAMES
from quizshow.team_colors import TEAM_COLOR_IDS, TEAM_COLORS

TILE_ID_PATTERN = re.compile(r"^\d+:\d+$")
PRESENTATION_SCREENS = {"standby", "team-lobby", "hub", "jeopardy-board", "jeopardy-question", "ordering", "listing", "sync", "victory", "score-history"}
HUB_GAME_IDS = {"jeopardy", "ordering", "listing", "sync"}

def validate_quiz_media_source(value: str, field: str) -> str:
    src = value.replace("\\", "/")
    match = re.fullmatch(r"/quiz-content/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/assets/(.+)", src)
    if not match or any(part in {"", ".", ".."} for part in match.group(2).split("/")):
        raise ValueError(f"{field}.src must be a packaged quiz asset.")
    return src


def validate_presentation_image(image: object, field: str) -> dict | None:
    if image is None:
        return None
    if not isinstance(image, dict) or not isinstance(image.get("src"), str) or not isinstance(image.get("alt"), str):
        raise ValueError(f"{field} must contain src and alt strings.")
    src = validate_quiz_media_source(image["src"], field)
    return {"src": src, "alt": image["alt"]}


def validate_presentation_audio(audio: object, field: str) -> dict | None:
    if audio is None:
        return None
    if not isinstance(audio, dict) or not isinstance(audio.get("src"), str) or not isinstance(audio.get("label"), str):
        raise ValueError(f"{field} must contain src and label strings.")
    src = validate_quiz_media_source(audio["src"], field)
    if not audio["label"].strip():
        raise ValueError(f"{field}.label must not be empty.")
    return {"src": src, "label": audio["label"]}


def validate_presentation_logos(logos: object) -> dict[str, str]:
    defaults = {key: f"/assets/Logos/{filename}" for key, filename in LOGO_FILENAMES.items()}
    if logos is None:
        return defaults
    if not isinstance(logos, dict) or set(logos) != set(LOGO_FILENAMES):
        raise ValueError("Presentation logos are invalid.")
    clean = {}
    for key, filename in LOGO_FILENAMES.items():
        value = logos.get(key)
        if not isinstance(value, str):
            raise ValueError("Presentation logos are invalid.")
        escaped_filename = re.escape(filename)
        if (value != defaults[key]
                and not re.fullmatch(rf"/quiz-logos/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/{escaped_filename}", value)):
            raise ValueError("Presentation logos are invalid.")
        clean[key] = value
    return clean


def validate_presentation(payload: object) -> dict:
    if not isinstance(payload, dict) or payload.get("screen") not in PRESENTATION_SCREENS:
        raise ValueError("Presentation screen is invalid.")
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("Presentation title is required.")
    teams = payload.get("teams", [])
    if not isinstance(teams, list):
        raise ValueError("Presentation teams must be an array.")
    clean_teams = []
    used_colors: set[str] = set()
    for index, team in enumerate(teams):
        if not isinstance(team, dict) or not isinstance(team.get("name"), str):
            raise ValueError("Each presentation team needs a name.")
        score = team.get("score")
        if not isinstance(score, int) or isinstance(score, bool):
            raise ValueError("Each presentation team needs an integer score.")
        color = team.get("color", TEAM_COLORS[index % len(TEAM_COLORS)]["id"])
        if color not in TEAM_COLOR_IDS or color in used_colors:
            raise ValueError("Each presentation team needs a valid color.")
        used_colors.add(color)
        clean_teams.append({"name": team["name"], "score": score, "color": color})

    clean: dict = {
        "screen": payload["screen"], "title": title, "teams": clean_teams,
        "logos": validate_presentation_logos(payload.get("logos")),
    }
    score_adjustment = payload.get("scoreAdjustment")
    if score_adjustment is not None:
        if (not isinstance(score_adjustment, dict)
                or not isinstance(score_adjustment.get("id"), str)
                or not score_adjustment["id"].strip()
                or not isinstance(score_adjustment.get("teamIndex"), int)
                or isinstance(score_adjustment.get("teamIndex"), bool)
                or not 0 <= score_adjustment["teamIndex"] < len(clean_teams)
                or not isinstance(score_adjustment.get("amount"), int)
                or isinstance(score_adjustment.get("amount"), bool)
                or score_adjustment["amount"] == 0):
            raise ValueError("Presentation scoreAdjustment is invalid.")
        clean["scoreAdjustment"] = {
            "id": score_adjustment["id"],
            "teamIndex": score_adjustment["teamIndex"],
            "amount": score_adjustment["amount"],
        }
    audio_settings = payload.get("audioSettings")
    if audio_settings is None:
        clean["audioSettings"] = {
            "effectsEnabled": True, "tensionMusicEnabled": True, "ambientMusicEnabled": True
        }
    else:
        audio_keys = ("effectsEnabled", "tensionMusicEnabled", "ambientMusicEnabled")
        if (not isinstance(audio_settings, dict)
                or any(not isinstance(audio_settings.get(key), bool) for key in audio_keys)):
            raise ValueError("Presentation audio settings are invalid.")
        clean["audioSettings"] = {key: audio_settings[key] for key in audio_keys}
    join_overlay = payload.get("joinOverlay")
    if join_overlay is not None:
        if not isinstance(join_overlay, dict) or not isinstance(join_overlay.get("joinUrl"), str):
            raise ValueError("Presentation join overlay is invalid.")
        join_url = join_overlay["joinUrl"]
        if not re.fullmatch(r"https?://[^/\s]+/player", join_url):
            raise ValueError("Presentation join URL is invalid.")
        clean["joinOverlay"] = {"joinUrl": join_url}
    if payload["screen"] == "hub":
        games = payload.get("games")
        if (not isinstance(games, list) or not games
                or any(not isinstance(game, str) or game not in HUB_GAME_IDS for game in games)
                or len(games) != len(set(games))):
            raise ValueError("Available hub games are invalid.")
        highlighted_game = payload.get("highlightedGame")
        if highlighted_game is not None and highlighted_game not in games:
            raise ValueError("Highlighted hub game is invalid.")
        clean["games"] = games
        clean["highlightedGame"] = highlighted_game
    elif payload["screen"] == "team-lobby":
        join_url = payload.get("joinUrl")
        if not isinstance(join_url, str) or not re.fullmatch(r"https?://[^/\s]+/player", join_url):
            raise ValueError("Team lobby join URL is invalid.")
        clean["joinUrl"] = join_url
    elif payload["screen"] == "jeopardy-board":
        board = payload.get("board")
        if not isinstance(board, dict):
            raise ValueError("Jeopardy board data is required.")
        categories = board.get("categories")
        values = board.get("values")
        used_tiles = board.get("usedTiles")
        if (not isinstance(categories, list) or not categories
                or any(not isinstance(item, str) for item in categories)):
            raise ValueError("Board categories are invalid.")
        if (not isinstance(values, list) or not values
                or any(not isinstance(item, int) or isinstance(item, bool) for item in values)):
            raise ValueError("Board values are invalid.")
        if (not isinstance(used_tiles, list)
                or any(not isinstance(item, str) or not TILE_ID_PATTERN.fullmatch(item) for item in used_tiles)):
            raise ValueError("Board usedTiles are invalid.")
        highlighted_tile = board.get("highlightedTile")
        if highlighted_tile is not None:
            if not isinstance(highlighted_tile, str) or not TILE_ID_PATTERN.fullmatch(highlighted_tile):
                raise ValueError("Board highlightedTile is invalid.")
            category_index, row_index = map(int, highlighted_tile.split(":"))
            if (category_index >= len(categories) or row_index >= len(values)
                    or highlighted_tile in used_tiles):
                raise ValueError("Board highlightedTile is unavailable.")
        clean["board"] = {
            "categories": categories, "values": values, "usedTiles": used_tiles,
            "highlightedTile": highlighted_tile,
        }
    elif payload["screen"] == "jeopardy-question":
        question = payload.get("question")
        if not isinstance(question, dict) or not isinstance(question.get("id"), str) or not TILE_ID_PATTERN.fullmatch(question["id"]):
            raise ValueError("Current question data is invalid.")
        revealed = question.get("answerRevealed")
        if not isinstance(revealed, bool):
            raise ValueError("answerRevealed must be a boolean.")
        value = question.get("value")
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError("Question value must be a positive integer.")
        question_text = question.get("question")
        answer_text = question.get("answer")
        if question_text is not None and not isinstance(question_text, str):
            raise ValueError("Question text must be a string or null.")
        if answer_text is not None and not isinstance(answer_text, str):
            raise ValueError("Answer text must be a string or null.")
        question_image = validate_presentation_image(question.get("questionImage"), "questionImage")
        answer_image = validate_presentation_image(question.get("answerImage"), "answerImage")
        question_audio = validate_presentation_audio(question.get("questionAudio"), "questionAudio")
        answer_audio = validate_presentation_audio(question.get("answerAudio"), "answerAudio")
        audio_command = question.get("audioCommand")
        clean_audio_command = None
        if audio_command is not None:
            if (not isinstance(audio_command, dict) or not isinstance(audio_command.get("id"), str)
                    or not audio_command["id"].strip()
                    or audio_command.get("action") not in {"play", "pause", "restart", "stop"}
                    or audio_command.get("target") not in {None, "question", "answer"}):
                raise ValueError("audioCommand is invalid.")
            if audio_command["action"] != "stop" and audio_command["target"] is None:
                raise ValueError("Audio playback commands require a target.")
            if audio_command["target"] == "answer" and not revealed:
                raise ValueError("Answer audio cannot be controlled before reveal.")
            if audio_command["target"] == "question" and question_audio is None:
                raise ValueError("The current question has no question audio.")
            if audio_command["target"] == "answer" and answer_audio is None:
                raise ValueError("The current question has no answer audio.")
            clean_audio_command = {
                "id": audio_command["id"], "action": audio_command["action"], "target": audio_command["target"]
            }
        if not revealed and (answer_text is not None or answer_image is not None or answer_audio is not None):
            raise ValueError("An unrevealed presentation must not contain an answer.")
        clean["question"] = {
            "id": question["id"], "value": value, "question": question_text, "questionImage": question_image,
            "questionAudio": question_audio,
            "answerRevealed": revealed, "answer": answer_text if revealed else None,
            "answerImage": answer_image if revealed else None, "answerAudio": answer_audio if revealed else None,
            "audioCommand": clean_audio_command,
        }
    elif payload["screen"] == "ordering":
        scoring_example = payload.get("scoringExample")
        clean_scoring_example = None
        if scoring_example is not None:
            if (not isinstance(scoring_example, dict)
                    or scoring_example.get("scoringMode") not in {"relative", "exact"}
                    or not isinstance(scoring_example.get("pointsPerCorrect"), int)
                    or isinstance(scoring_example.get("pointsPerCorrect"), bool)
                    or scoring_example["pointsPerCorrect"] <= 0):
                raise ValueError("Order Up scoring example is invalid.")
            clean_scoring_example = {
                "scoringMode": scoring_example["scoringMode"],
                "pointsPerCorrect": scoring_example["pointsPerCorrect"],
            }
        clean["scoringExample"] = clean_scoring_example
        ordering_map = payload.get("orderingMap")
        clean_ordering_map = None
        if ordering_map is not None:
            if (not isinstance(ordering_map, dict)
                    or not isinstance(ordering_map.get("label"), str)
                    or not ordering_map["label"].strip()):
                raise ValueError("Order Up map needs a non-empty label.")
            map_image = validate_presentation_image(ordering_map.get("image"), "orderingMap.image")
            if map_image is None:
                raise ValueError("Order Up map needs an image.")
            clean_ordering_map = {"label": ordering_map["label"], "image": map_image}
        clean["orderingMap"] = clean_ordering_map
        selection = payload.get("questionSelection")
        if selection is not None:
            if not isinstance(selection, dict) or not isinstance(selection.get("questions"), list):
                raise ValueError("Order Up question selection is invalid.")
            clean_questions = []
            question_ids = set()
            for question in selection["questions"]:
                if (not isinstance(question, dict) or not isinstance(question.get("id"), str)
                        or not question["id"].strip() or not isinstance(question.get("title"), str)
                        or not question["title"].strip() or not isinstance(question.get("completed"), bool)):
                    raise ValueError("Each Order Up question selection needs an id, title, and completed flag.")
                if question["id"] in question_ids:
                    raise ValueError("Order Up question selection ids must be unique.")
                question_ids.add(question["id"])
                clean_questions.append({
                    "id": question["id"], "title": question["title"], "completed": question["completed"]
                })
            highlighted_id = selection.get("highlightedQuestionId")
            if highlighted_id is not None and highlighted_id not in question_ids:
                raise ValueError("Highlighted Order Up question is invalid.")
            selected_question = selection.get("selectedQuestion")
            clean_selected_question = None
            if selected_question is not None:
                if (not isinstance(selected_question, dict)
                        or selected_question.get("id") not in question_ids
                        or not isinstance(selected_question.get("title"), str)
                        or not selected_question["title"].strip()
                        or not isinstance(selected_question.get("prompt"), str)
                        or not selected_question["prompt"].strip()
                        or not isinstance(selected_question.get("items"), list)
                        or not selected_question["items"]
                        or any(not isinstance(item, str) or not item.strip() for item in selected_question["items"])):
                    raise ValueError("Selected Order Up question is invalid.")
                clean_selected_question = {
                    "id": selected_question["id"], "title": selected_question["title"],
                    "prompt": selected_question["prompt"], "items": selected_question["items"]
                }
            clean["questionSelection"] = {
                "questions": clean_questions, "highlightedQuestionId": highlighted_id,
                "selectedQuestion": clean_selected_question
            }
    elif payload["screen"] == "listing":
        selection = payload.get("questionSelection")
        clean_selection = None
        if selection is not None:
            if not isinstance(selection, dict) or not isinstance(selection.get("questions"), list):
                raise ValueError("List It question selection is invalid.")
            clean_questions = []
            question_ids = set()
            for question in selection["questions"]:
                if (not isinstance(question, dict) or not isinstance(question.get("id"), str)
                        or not question["id"].strip()
                        or not isinstance(question.get("displayCategory"), str)
                        or not question["displayCategory"].strip()
                        or not isinstance(question.get("completed"), bool)):
                    raise ValueError("Each List It question selection needs an id, display category, and completed flag.")
                if question["id"] in question_ids:
                    raise ValueError("List It question selection ids must be unique.")
                question_ids.add(question["id"])
                clean_questions.append({
                    "id": question["id"], "displayCategory": question["displayCategory"],
                    "completed": question["completed"]
                })
            highlighted_id = selection.get("highlightedQuestionId")
            if highlighted_id is not None and highlighted_id not in question_ids:
                raise ValueError("Highlighted List It question is invalid.")
            selected_question = selection.get("selectedQuestion")
            clean_selected_question = None
            if selected_question is not None:
                if (not isinstance(selected_question, dict)
                        or selected_question.get("id") not in question_ids
                        or not isinstance(selected_question.get("title"), str)
                        or not selected_question["title"].strip()
                        or not isinstance(selected_question.get("prompt"), str)
                        or not selected_question["prompt"].strip()):
                    raise ValueError("Selected List It question is invalid.")
                clean_selected_question = {
                    "id": selected_question["id"], "title": selected_question["title"],
                    "prompt": selected_question["prompt"]
                }
            clean_selection = {
                "questions": clean_questions, "highlightedQuestionId": highlighted_id,
                "selectedQuestion": clean_selected_question
            }
        clean["questionSelection"] = clean_selection
    elif payload["screen"] == "victory":
        steps = payload.get("steps")
        revealed_count = payload.get("revealedCount")
        if not isinstance(steps, list) or not isinstance(revealed_count, int) or isinstance(revealed_count, bool):
            raise ValueError("Victory reveal data is invalid.")
        clean_steps = []
        for step in steps:
            if (not isinstance(step, dict) or step.get("kind") not in {"standing", "podium"}
                    or not isinstance(step.get("rank"), int) or isinstance(step.get("rank"), bool)
                    or not isinstance(step.get("names"), str)
                    or not isinstance(step.get("score"), int) or isinstance(step.get("score"), bool)):
                raise ValueError("A victory step is invalid.")
            clean_steps.append({"kind": step["kind"], "rank": step["rank"], "names": step["names"], "score": step["score"]})
        clean["steps"] = clean_steps
        clean["revealedCount"] = max(0, min(revealed_count, len(clean_steps)))
    elif payload["screen"] == "score-history":
        history = payload.get("scoreHistory")
        if not isinstance(history, list) or not history:
            raise ValueError("Score history presentation data is invalid.")
        clean_history = []
        for entry in history:
            scores = entry.get("scores") if isinstance(entry, dict) else None
            if (not isinstance(scores, list) or len(scores) != len(clean_teams)
                    or any(not isinstance(score, int) or isinstance(score, bool) for score in scores)):
                raise ValueError("Each score history step needs one integer score per team.")
            game = entry.get("game")
            if game not in {None, "jeopardy", "ordering", "listing", "sync"}:
                raise ValueError("Each score history step needs a valid game.")
            clean_history.append({"scores": scores, "game": game})
        clean["scoreHistory"] = clean_history
    return clean


class PresentationState:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.version = int(time.time() * 1000)
        self.server_session_id = f"{self.version}-{secrets.token_hex(8)}"
        self.payload = validate_presentation({"screen": "standby", "title": "Quizzy", "teams": []})

    def update(self, payload: object) -> dict:
        clean = validate_presentation(payload)
        with self.condition:
            self.version += 1
            self.payload = clean
            self.condition.notify_all()
            return self._snapshot_unlocked()

    def _snapshot_unlocked(self) -> dict:
        return {"version": self.version, "serverSessionId": self.server_session_id, **self.payload}

    def snapshot(self) -> dict:
        with self.condition:
            return self._snapshot_unlocked()

