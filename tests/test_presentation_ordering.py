import unittest

import main


class PresentationOrderingTests(unittest.TestCase):
    def test_accepts_ordering_map(self):
        clean = main.validate_presentation({
            "screen": "ordering", "title": "Quizshow", "teams": [],
            "orderingMap": {
                "label": "Römisches Reich",
                "image": {"src": "/quiz-content/test-quiz/assets/Maps/R%C3%B6misches%20Reich.png", "alt": "Karte"},
            },
        })

        self.assertEqual("Römisches Reich", clean["orderingMap"]["label"])
        self.assertEqual("/quiz-content/test-quiz/assets/Maps/R%C3%B6misches%20Reich.png", clean["orderingMap"]["image"]["src"])

    def test_rejects_unsafe_ordering_map(self):
        with self.assertRaisesRegex(ValueError, "packaged quiz asset"):
            main.validate_presentation({
                "screen": "ordering", "title": "Quizshow", "teams": [],
                "orderingMap": {
                    "label": "Geheim", "image": {"src": "assets/../secret.png", "alt": "Geheim"},
                },
            })

    def test_rejects_ordering_map_without_label(self):
        with self.assertRaisesRegex(ValueError, "non-empty label"):
            main.validate_presentation({
                "screen": "ordering", "title": "Quizshow", "teams": [],
                "orderingMap": {"label": "", "image": {"src": "/quiz-content/test-quiz/assets/map.png", "alt": "Karte"}},
            })

    def test_accepts_ordering_question_selection(self):
        clean = main.validate_presentation({
            "screen": "ordering",
            "title": "Quizshow",
            "teams": [],
            "questionSelection": {
                "questions": [
                    {"id": "history", "title": "History", "completed": False},
                    {"id": "music", "title": "Music", "completed": True},
                ],
                "highlightedQuestionId": "history",
                "selectedQuestion": {
                    "id": "history", "title": "History", "prompt": "Sort these events.",
                    "items": ["First", "Third", "Second"]
                },
            },
        })

        self.assertEqual("history", clean["questionSelection"]["highlightedQuestionId"])
        self.assertEqual("Sort these events.", clean["questionSelection"]["selectedQuestion"]["prompt"])
        self.assertEqual(["First", "Third", "Second"], clean["questionSelection"]["selectedQuestion"]["items"])
        self.assertTrue(clean["questionSelection"]["questions"][1]["completed"])

    def test_rejects_unknown_highlighted_question(self):
        with self.assertRaisesRegex(ValueError, "Highlighted Order Up question"):
            main.validate_presentation({
                "screen": "ordering",
                "title": "Quizshow",
                "teams": [],
                "questionSelection": {
                    "questions": [{"id": "history", "title": "History", "completed": False}],
                    "highlightedQuestionId": "missing",
                },
            })


if __name__ == "__main__":
    unittest.main()
