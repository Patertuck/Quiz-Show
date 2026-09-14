import base64
import csv
import io
import struct
import tempfile
import unittest
from pathlib import Path

import main


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


class FinalExportTests(unittest.TestCase):
    def test_csv_contains_scores_changes_and_game_labels(self):
        decoded = main.final_export_csv(state()).decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(decoded), delimiter=";"))
        self.assertEqual(["Schritt", "Spiel", "Rot – Punktestand", "Rot – Veränderung", "Blau – Punktestand", "Blau – Veränderung"], rows[0])
        self.assertEqual(["0", "Start", "0", "0", "0", "0"], rows[1])
        self.assertEqual(["1", "Jeopardy", "300", "300", "0", "0"], rows[2])
        self.assertEqual(["2", "Sync Up", "300", "0", "-100", "-100"], rows[3])

    def test_rejects_wrong_png_dimensions(self):
        with self.assertRaisesRegex(ValueError, "1920 × 1080"):
            main._decode_export_png(png(1280, 720), "podiumPng")

    def test_saves_three_files_and_deduplicates_same_result(self):
        payload = {"podiumPng": png(), "scoreHistoryPng": png()}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            first, created = main.save_final_export(payload, state(), output)
            second, created_again = main.save_final_export(payload, state(), output)
            self.assertTrue(created)
            self.assertFalse(created_again)
            self.assertEqual(first, second)
            self.assertEqual({"podest.png", "punkteverlauf.png", "punkteverlauf.csv"}, {path.name for path in first.iterdir()})

    def test_changed_score_history_creates_new_export(self):
        payload = {"podiumPng": png(), "scoreHistoryPng": png()}
        changed = state()
        changed["teams"][0]["score"] = 400
        changed["scoreHistory"].append({"scores": [400, -100], "game": "sync"})
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            first, _ = main.save_final_export(payload, state(), output)
            second, created = main.save_final_export(payload, changed, output)
            self.assertTrue(created)
            self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
