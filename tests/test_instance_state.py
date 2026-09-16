import json
import tempfile
import unittest
from pathlib import Path

from instance_state import InstanceStateStore


class InstanceStateStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "state.json"
        self.store = InstanceStateStore(self.path)

    def test_section_updates_preserve_all_other_sections(self):
        self.store.write("game", {"revision": 4})
        self.store.write("listing", {"version": 1, "completedQuestionIds": ["q1"]})

        saved = json.loads(self.path.read_text(encoding="utf-8-sig"))
        self.assertEqual(1, saved["version"])
        self.assertEqual({"revision": 4}, saved["game"])
        self.assertEqual(["q1"], saved["listing"]["completedQuestionIds"])
        self.assertIsNone(saved["ordering"])
        self.assertIsNone(saved["sync"])

    def test_rejects_incomplete_or_invalid_combined_state(self):
        self.path.write_text('{"version": 1, "game": {}}', encoding="utf-8")
        with self.assertRaises(ValueError):
            InstanceStateStore(self.path)

        self.path.write_text(
            json.dumps({"version": 1, "game": None, "ordering": [], "listing": None, "sync": None}),
            encoding="utf-8",
        )
        with self.assertRaises(ValueError):
            InstanceStateStore(self.path)

    def test_stale_game_revision_does_not_replace_newer_state(self):
        self.assertTrue(self.store.write_game({"revision": 8}, 8))
        self.assertFalse(self.store.write_game({"revision": 7}, 7))
        self.assertEqual(8, self.store.read("game")["revision"])

    def test_failed_switch_keeps_previous_store_bound(self):
        self.store.write("game", {"revision": 2})
        invalid = self.path.with_name("invalid.json")
        invalid.write_text("not-json", encoding="utf-8")

        with self.assertRaises(ValueError):
            self.store.switch(invalid)

        self.assertEqual(self.path, self.store.path)
        self.assertEqual(2, self.store.read("game")["revision"])


if __name__ == "__main__":
    unittest.main()
