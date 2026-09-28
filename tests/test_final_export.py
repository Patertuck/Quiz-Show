import base64
import csv
import io
import struct
import tempfile
import unittest
from pathlib import Path

from quizshow import final_export


def png(width=1920, height=1080):
    data = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", width, height)
    return base64.b64encode(data).decode("ascii")


def state():
    return {
        "teams": [{"name": "Rot", "score": 300}, {"name": "Blau", "score": -100}],
        "scoreHistory": [
            {"scores": [0, 0], "game": None},
            {"scores": [300, 0], "game": "jeopardy"},
            {"scores": [300, -100], "game": "sync"},
        ],
    }


def payload():
    return {
        "podiumPng": png(), "scoreHistoryPng": png(),
        "highlightsPng": png(), "gameBreakdownPng": png(),
        "gameIds": ["jeopardy", "sync"],
    }


class FinalExportTests(unittest.TestCase):
    def test_csv_contains_scores_changes_and_game_labels(self):
        decoded = final_export.final_export_csv(state()).decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(decoded), delimiter=";"))
        self.assertEqual(["Schritt", "Spiel", "Rot – Punktestand", "Rot – Veränderung", "Blau – Punktestand", "Blau – Veränderung"], rows[0])
        self.assertEqual(["0", "Start", "0", "0", "0", "0"], rows[1])
        self.assertEqual(["1", "Jeopardy", "300", "300", "0", "0"], rows[2])
        self.assertEqual(["2", "Sync Up", "300", "0", "-100", "-100"], rows[3])

    def test_rejects_wrong_png_dimensions(self):
        with self.assertRaisesRegex(ValueError, "1920 × 1080"):
            final_export._decode_export_png(png(1280, 720), "podiumPng")

    def test_saves_three_files_and_deduplicates_same_result(self):
        export_payload = payload()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            first, created = final_export.save_final_export(export_payload, state(), output)
            second, created_again = final_export.save_final_export(export_payload, state(), output)
            self.assertTrue(created)
            self.assertFalse(created_again)
            self.assertEqual(first, second)
            self.assertTrue(first.name.startswith("quizzy-"))
            self.assertEqual({"podest.png", "punkteverlauf.png", "highlights.png", "spielvergleich.png", "punkteverlauf.csv", "statistiken.csv"}, {path.name for path in first.iterdir()})

    def test_legacy_quizshow_export_is_reused(self):
        export_payload = payload()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            export_key = final_export.final_export_key(state(), export_payload["gameIds"])
            legacy = output / f"quizshow-2026-01-01_12-00-00_{export_key}"
            legacy.mkdir()
            reused, created = final_export.save_final_export(export_payload, state(), output)
            self.assertEqual(legacy, reused)
            self.assertFalse(created)

    def test_changed_score_history_creates_new_export(self):
        export_payload = payload()
        changed = state()
        changed["teams"][0]["score"] = 400
        changed["scoreHistory"].append({"scores": [400, -100], "game": "sync"})
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            first, _ = final_export.save_final_export(export_payload, state(), output)
            second, created = final_export.save_final_export(export_payload, changed, output)
            self.assertTrue(created)
            self.assertNotEqual(first, second)

    def test_statistics_csv_contains_quiz_team_and_game_rows(self):
        decoded = final_export.final_statistics_csv(state(), ["jeopardy", "sync"]).decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(decoded), delimiter=";"))
        self.assertIn(["Quiz", "Siegervorsprung", "Rot", "", "400"], rows)
        self.assertIn(["Team", "Positive Punkte", "Rot", "", "300"], rows)
        self.assertIn(["Spiel", "Netto-Punkte", "Blau", "Sync Up", "-100"], rows)
        self.assertIn(["Spielübersicht", "Nettopunkte", "", "Jeopardy", "300"], rows)
        self.assertIn(["Spielübersicht", "Anteil Prozent", "", "Jeopardy", "75.0"], rows)
        self.assertIn(["Spielübersicht", "Spanne", "", "Sync Up", "100"], rows)

    def test_new_export_images_and_game_ids_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "highlightsPng"):
                final_export.save_final_export({"podiumPng": png(), "scoreHistoryPng": png()}, state(), Path(temporary))


if __name__ == "__main__":
    unittest.main()
