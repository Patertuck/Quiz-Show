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
        self.variations = root / "variations"
        self.instances = root / "instances"
        self.library = QuizLibrary(self.variations, self.instances)
        for package, title in (("alpha", "Alpha"), ("beta", "Beta")):
            (self.variations / package).mkdir()
            (self.variations / package / "quiz-config.json").write_text(
                json.dumps({"title": title}), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def test_discovers_only_direct_variation_packages(self):
        (self.variations / "notes.txt").write_text("no", encoding="utf-8")
        nested = self.variations / "nested"
        nested.mkdir()
        (nested / "hidden.json").write_text("{}", encoding="utf-8")

        self.assertEqual(["alpha", "beta"], [item["id"] for item in self.library.variations()])
        self.assertEqual("/quiz-content/alpha/quiz-config.json", self.library.variations()[0]["url"])

    def test_create_activate_rename_and_delete_named_instances(self):
        first = self.library.create("first-game", "alpha")
        second = self.library.create("second-game", "beta")
        self.assertEqual("first-game", first)
        self.assertEqual("second-game", self.library.active_instance_name())
        self.assertEqual(self.instances / "second-game" / "results", self.library.active_results_directory())
        self.library.activate(first)
        results = self.instances / first / "results"
        results.mkdir()
        (results / "scores.csv").write_text("scores", encoding="utf-8")
        renamed = self.library.rename(first, "renamed-game")
        self.assertEqual("renamed-game", renamed)
        self.assertEqual("renamed-game", self.library.active_instance_name())
        entries = {item["name"]: item for item in self.library.instances()}
        self.assertFalse(entries["renamed-game"]["hasState"])
        self.assertTrue(entries["renamed-game"]["hasResults"])
        self.assertTrue((self.instances / "renamed-game" / "results" / "scores.csv").is_file())
        self.assertTrue(self.library.delete("renamed-game"))
        self.assertIsNone(self.library.active_instance_name())
        self.assertFalse(self.library.delete(second))

    def test_instance_names_are_globally_unique_and_safe(self):
        self.library.create("evening-round", "alpha")
        with self.assertRaisesRegex(ValueError, "existiert bereits"):
            self.library.create("evening-round", "beta")
        for name in ("Evening", "two words", "../escape", "-leading", "trailing-"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.library.create(name, "alpha")

    def test_instance_state_paths_are_isolated(self):
        self.library.create("first", "alpha")
        first_path = self.library.active_state_path("game-state.json")
        first_path.write_text('{"instance": 1}', encoding="utf-8")
        self.library.create("second", "alpha")
        second_path = self.library.active_state_path("game-state.json")
        second_path.write_text('{"instance": 2}', encoding="utf-8")

        self.library.activate("first")
        self.assertEqual('{"instance": 1}', self.library.active_state_path("game-state.json").read_text(encoding="utf-8"))
        self.library.activate("second")
        self.assertEqual('{"instance": 2}', self.library.active_state_path("game-state.json").read_text(encoding="utf-8"))

    def test_new_library_process_starts_without_active_instance(self):
        self.library.create("saved-game", "alpha")
        restarted = QuizLibrary(self.variations, self.instances)
        self.assertIsNone(restarted.active_instance_name())
        self.assertEqual(["saved-game"], [item["name"] for item in restarted.instances()])

    def test_missing_variation_disables_activation_but_keeps_instance(self):
        self.library.create("missing-variation", "alpha")
        (self.variations / "alpha" / "quiz-config.json").unlink()
        self.assertFalse(self.library.instances()[0]["variationAvailable"])
        with self.assertRaisesRegex(ValueError, "fehlt"):
            self.library.activate("missing-variation")

    def test_changed_variation_does_not_block_existing_instance(self):
        self.library.create("editable-variation", "alpha")
        config = self.variations / "alpha" / "quiz-config.json"
        config.write_text(json.dumps({"title": "Changed questions"}), encoding="utf-8")

        restarted = QuizLibrary(self.variations, self.instances)
        self.assertEqual("editable-variation", restarted.activate("editable-variation"))

    def test_content_paths_only_expose_config_and_contained_assets(self):
        assets = self.variations / "alpha" / "assets"
        assets.mkdir()
        media = assets / "map.png"
        media.write_bytes(b"png")

        self.assertEqual((media.resolve(), "asset"), self.library.content_path("/quiz-content/alpha/assets/map.png"))
        self.assertEqual("config", self.library.content_path("/quiz-content/alpha/quiz-config.json")[1])
        self.assertIsNone(self.library.content_path("/quiz-content/alpha/results/private.csv"))
        self.assertIsNone(self.library.content_path("/quiz-content/alpha/assets/../quiz-config.json"))

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
            service.configure(["Team 1"], ["question"])
            with service.condition:
                service.completed = ["question"]
                service._changed_unlocked()
            service.switch_storage(second / service.state_file.name)
            service.configure(["Team 1"], ["question"])
            self.assertEqual([], service.completed)
            service.switch_storage(first / service.state_file.name)
            self.assertEqual(["question"], service.completed)


if __name__ == "__main__":
    unittest.main()
