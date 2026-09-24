import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from instance_state import InstanceStateStore


def game_state(revision=1):
    return {
        "version": 5,
        "updatedAt": "2026-09-19T10:00:00Z",
        "revision": revision,
        "gameStarted": True,
        "teams": [{"name": "Rot", "score": 100}, {"name": "Blau", "score": 0}],
        "usedTiles": ["0:0"],
        "activeQuestion": None,
        "appliedAwards": ["award-1"],
        "scoreHistory": [
            {"scores": [0, 0], "game": None},
            {"scores": [100, 0], "game": "jeopardy"},
        ],
        "scoreHistoryGame": "jeopardy",
        "shownRuleGameIds": ["jeopardy"],
    }


def colored_game_state(revision=1):
    state = game_state(revision)
    state["version"] = 6
    state["teams"] = [
        {**team, "color": color} for team, color in zip(state["teams"], ("sun", "cyan"), strict=True)
    ]
    return state


def legacy_document():
    return {
        "version": 1,
        "game": game_state(4),
        "ordering": {
            "version": 1,
            "teams": ["Rot", "Blau"],
            "completedQuestionIds": [],
            "round": {"phase": "active", "deadlineAt": 1_900_000_000_000},
        },
        "listing": None,
        "sync": None,
    }


class InstanceStateStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "state.json"
        self.store = InstanceStateStore(self.path)

    def test_legacy_writes_are_combined_into_version_two_session(self):
        self.assertTrue(self.store.write_game(game_state(4), 4))
        self.store.write("listing", {"version": 1, "completedQuestionIds": ["q1"]})

        saved = json.loads(self.path.read_text(encoding="utf-8-sig"))
        self.assertEqual(2, saved["version"])
        self.assertEqual(4, saved["session"]["revision"])
        self.assertEqual(["q1"], saved["session"]["games"]["listing"]["completedQuestionIds"])
        self.assertEqual(colored_game_state(4), self.store.read("game"))
        self.assertIsNone(self.store.read("ordering"))

    def test_rejects_incomplete_or_invalid_documents(self):
        self.path.write_text('{"version": 1, "game": {}}', encoding="utf-8")
        with self.assertRaises(ValueError):
            InstanceStateStore(self.path)

        self.path.write_text('{"version": 2, "session": [], "extra": true}', encoding="utf-8")
        with self.assertRaises(ValueError):
            InstanceStateStore(self.path)

    def test_stale_game_revision_does_not_replace_newer_state(self):
        self.assertTrue(self.store.write_game(game_state(8), 8))
        self.assertFalse(self.store.write_game(game_state(7), 7))
        self.assertEqual(8, self.store.read("game")["revision"])

    def test_failed_switch_keeps_previous_store_bound(self):
        self.store.write_game(game_state(2), 2)
        invalid = self.path.with_name("invalid.json")
        invalid.write_text("not-json", encoding="utf-8")

        with self.assertRaises(ValueError):
            self.store.switch(invalid)

        self.assertEqual(self.path, self.store.path)
        self.assertEqual(2, self.store.read("game")["revision"])

    def test_version_one_migrates_in_memory_and_creates_one_recovery_copy(self):
        original = legacy_document()
        self.path.write_text(json.dumps(original), encoding="utf-8")
        store = InstanceStateStore(self.path)

        self.assertEqual(4, store.read_session().revision)
        self.assertEqual(1_900_000_000, store.read_session().timer_deadlines["ordering"])
        self.assertEqual(1, json.loads(self.path.read_text(encoding="utf-8"))["version"])

        store.write("listing", {"version": 1, "completedQuestionIds": []})
        backup = self.path.with_name("state.v1.backup.json")
        self.assertEqual(original, json.loads(backup.read_text(encoding="utf-8")))
        self.assertEqual(2, json.loads(self.path.read_text(encoding="utf-8"))["version"])

        store.write("listing", None)
        self.assertEqual(original, json.loads(backup.read_text(encoding="utf-8")))

    def test_failed_atomic_replace_keeps_memory_and_file_unchanged(self):
        self.store.write_game(game_state(2), 2)
        before_file = self.path.read_bytes()
        before_session = self.store.read_session()

        with patch("instance_state.os.replace", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.store.write_game(game_state(3), 3)

        self.assertEqual(before_file, self.path.read_bytes())
        self.assertEqual(before_session, self.store.read_session())
        self.assertFalse(self.path.with_name(".state.json.tmp").exists())

    def test_version_two_round_trip_preserves_deadlines(self):
        self.store.write_game(game_state(3), 3)
        self.store.write("sync", {"version": 1, "round": {
            "phase": "active", "deadlineAt": 1_900_000_012_345,
        }})

        restarted = InstanceStateStore(self.path)

        self.assertEqual(1_900_000_012.345, restarted.read_session().timer_deadlines["sync"])
        self.assertEqual("active", restarted.read("sync")["round"]["phase"])


if __name__ == "__main__":
    unittest.main()
