import unittest

import main


class PresentationRulesExampleTests(unittest.TestCase):
    def validate(self, example):
        return main.validate_presentation({
            "screen": "rules-example", "title": "Quizshow", "teams": [], "example": example,
        })["example"]

    def test_accepts_each_game_example(self):
        examples = [
            {"gameId": "jeopardy", "value": 100},
            {"gameId": "ordering", "scoringMode": "relative", "pointsPerCorrect": 50},
            {"gameId": "listing", "placementPoints": [300, 200, 100, 0]},
            {"gameId": "sync", "pointsPerSync": 100},
        ]
        for example in examples:
            with self.subTest(game=example["gameId"]):
                self.assertEqual(example, self.validate(example))

    def test_rejects_invalid_examples(self):
        examples = [
            {"gameId": "unknown", "value": 100},
            {"gameId": "jeopardy", "value": 0},
            {"gameId": "ordering", "scoringMode": "distance", "pointsPerCorrect": 50},
            {"gameId": "listing", "placementPoints": []},
            {"gameId": "listing", "placementPoints": [100, -1]},
            {"gameId": "sync", "pointsPerSync": True},
        ]
        for example in examples:
            with self.subTest(example=example), self.assertRaisesRegex(ValueError, "example"):
                self.validate(example)


if __name__ == "__main__":
    unittest.main()
