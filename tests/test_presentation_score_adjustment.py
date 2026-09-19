import unittest

from main import validate_presentation


def presentation(adjustment):
    return {
        "screen": "hub",
        "title": "Quizshow",
        "teams": [{"name": "Rot", "score": 100}],
        "games": ["jeopardy"],
        "highlightedGame": None,
        "scoreAdjustment": adjustment,
    }


class PresentationScoreAdjustmentTests(unittest.TestCase):
    def test_accepts_positive_and_negative_adjustments(self):
        for amount in (100, -50):
            with self.subTest(amount=amount):
                clean = validate_presentation(presentation({
                    "id": f"adjustment-{amount}", "teamIndex": 0, "amount": amount,
                }))
                self.assertEqual(amount, clean["scoreAdjustment"]["amount"])

    def test_rejects_invalid_adjustments(self):
        invalid = [
            {"id": "", "teamIndex": 0, "amount": 10},
            {"id": "adjustment", "teamIndex": 1, "amount": 10},
            {"id": "adjustment", "teamIndex": 0, "amount": 0},
            {"id": "adjustment", "teamIndex": False, "amount": 10},
            {"id": "adjustment", "teamIndex": 0, "amount": True},
        ]
        for adjustment in invalid:
            with self.subTest(adjustment=adjustment), self.assertRaisesRegex(ValueError, "scoreAdjustment"):
                validate_presentation(presentation(adjustment))


if __name__ == "__main__":
    unittest.main()
