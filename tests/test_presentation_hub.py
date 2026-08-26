import unittest

import main


class PresentationHubTests(unittest.TestCase):
    def presentation(self, **extra):
        return {"screen": "hub", "title": "Quizshow", "teams": [], **extra}

    def test_accepts_available_games_and_highlight(self):
        clean = main.validate_presentation(self.presentation(
            games=["jeopardy", "listing"], highlightedGame="listing"
        ))
        self.assertEqual(["jeopardy", "listing"], clean["games"])
        self.assertEqual("listing", clean["highlightedGame"])

    def test_rejects_empty_duplicate_and_unknown_games(self):
        for games in ([], ["listing", "listing"], ["unknown"], [{"id": "listing"}]):
            with self.subTest(games=games), self.assertRaisesRegex(ValueError, "hub games"):
                main.validate_presentation(self.presentation(games=games))

    def test_rejects_highlight_for_unavailable_game(self):
        with self.assertRaisesRegex(ValueError, "Highlighted"):
            main.validate_presentation(self.presentation(
                games=["listing"], highlightedGame="jeopardy"
            ))


if __name__ == "__main__":
    unittest.main()
