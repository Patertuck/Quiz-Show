import json
import tempfile
import unittest
from pathlib import Path

import main
from listing_game import ListingState
from quiz_library import QuizLibrary
from sync_game import SyncState


class QuizLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.configs = root / "quizzes"
        self.saves = root / "saves"
        self.library = QuizLibrary(self.configs, self.saves)
        (self.configs / "alpha.json").write_text(json.dumps({"title": "Alpha"}), encoding="utf-8")
        (self.configs / "beta.json").write_text(json.dumps({"title": "Beta"}), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def test_discovers_only_direct_json_files(self):
        (self.configs / "notes.txt").write_text("no", encoding="utf-8")
        nested = self.configs / "nested"
        nested.mkdir()
        (nested / "hidden.json").write_text("{}", encoding="utf-8")

        self.assertEqual(["alpha.json", "beta.json"], [item["id"] for item in self.library.configurations()])

    def test_create_activate_rename_and_delete_slots(self):
        first = self.library.create("Erstes Spiel", "alpha.json")
        second = self.library.create("Zweites Spiel", "beta.json")
        self.assertEqual(second, self.library.active_slot_id())
        self.library.activate(first)
        self.library.rename(first, "Umbenannt")
        slots = {item["id"]: item for item in self.library.slots()}
        self.assertEqual("Umbenannt", slots[first]["name"])
        self.assertFalse(slots[first]["hasState"])
        self.assertTrue(self.library.delete(first))
        self.assertIsNone(self.library.active_slot_id())
        self.assertFalse(self.library.delete(second))

    def test_names_are_unique_per_configuration(self):
        self.library.create("Abendrunde", "alpha.json")
        with self.assertRaisesRegex(ValueError, "bereits"):
            self.library.create(" abendrunde ", "alpha.json")
        self.library.create("Abendrunde", "beta.json")

    def test_slot_state_paths_are_isolated(self):
        first = self.library.create("Eins", "alpha.json")
        first_path = self.library.active_state_path("game-state.json")
        first_path.write_text('{"slot": 1}', encoding="utf-8")
        second = self.library.create("Zwei", "alpha.json")
        second_path = self.library.active_state_path("game-state.json")
        second_path.write_text('{"slot": 2}', encoding="utf-8")

        self.assertNotEqual(first_path, second_path)
        self.library.activate(first)
        self.assertEqual('{"slot": 1}', self.library.active_state_path("game-state.json").read_text(encoding="utf-8"))
        self.library.activate(second)
        self.assertEqual('{"slot": 2}', self.library.active_state_path("game-state.json").read_text(encoding="utf-8"))

    def test_missing_config_disables_activation_but_keeps_slot(self):
        slot = self.library.create("Fehlt", "alpha.json")
        (self.configs / "alpha.json").unlink()
        self.assertFalse(self.library.slots()[0]["configAvailable"])
        with self.assertRaisesRegex(ValueError, "fehlt"):
            self.library.activate(slot)

    def test_rejects_unsafe_or_unknown_configuration(self):
        for config_id in ("../alpha.json", ".hidden.json", "missing.json"):
            with self.subTest(config_id=config_id), self.assertRaises(ValueError):
                self.library.create("Test", config_id)

    def test_persistent_game_services_switch_storage_without_leaking_progress(self):
        root = Path(self.temporary.name)
        first = root / "first"
        second = root / "second"
        first.mkdir()
        second.mkdir()
        services = [
            main.OrderingState(first / "ordering.json"),
            ListingState(first / "listing.json"),
            SyncState(first / "sync.json"),
        ]
        for service in services:
            service.configure("fingerprint", ["Team 1"], ["question"])
            with service.condition:
                service.completed = ["question"]
                service._changed_unlocked()
            service.switch_storage(second / service.state_file.name)
            service.configure("fingerprint", ["Team 1"], ["question"])
            self.assertEqual([], service.completed)
            service.switch_storage(first / service.state_file.name)
            self.assertEqual(["question"], service.completed)


if __name__ == "__main__":
    unittest.main()
