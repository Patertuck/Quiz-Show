import unittest

import main


class PresentationListingTests(unittest.TestCase):
    def test_accepts_listing_question_selection_without_private_fields(self):
        clean = main.validate_presentation({
            "screen": "listing",
            "title": "Quizshow",
            "teams": [],
            "questionSelection": {
                "questions": [
                    {
                        "id": "pets",
                        "displayCategory": "Zusammenleben",
                        "completed": False,
                        "validationRule": "This must stay private.",
                    },
                ],
                "highlightedQuestionId": "pets",
                "selectedQuestion": {
                    "id": "pets",
                    "title": "Haustiere",
                    "prompt": "Nennt verschiedene Haustiere.",
                    "validationRule": "This must stay private.",
                },
            },
        })

        self.assertEqual({
            "questions": [{
                "id": "pets", "displayCategory": "Zusammenleben", "completed": False,
            }],
            "highlightedQuestionId": "pets",
            "selectedQuestion": {
                "id": "pets", "title": "Haustiere", "prompt": "Nennt verschiedene Haustiere.",
            },
        }, clean["questionSelection"])
        self.assertNotIn("validationRule", clean["questionSelection"]["questions"][0])
        self.assertNotIn("validationRule", clean["questionSelection"]["selectedQuestion"])

    def test_accepts_listing_without_question_selection(self):
        clean = main.validate_presentation({
            "screen": "listing", "title": "Quizshow", "teams": []
        })

        self.assertIsNone(clean["questionSelection"])

    def test_rejects_unknown_highlighted_question(self):
        with self.assertRaisesRegex(ValueError, "Highlighted List It question"):
            main.validate_presentation({
                "screen": "listing",
                "title": "Quizshow",
                "teams": [],
                "questionSelection": {
                    "questions": [{
                        "id": "pets", "displayCategory": "Zusammenleben", "completed": False,
                    }],
                    "highlightedQuestionId": "missing",
                },
            })

    def test_rejects_selected_question_without_prompt(self):
        with self.assertRaisesRegex(ValueError, "Selected List It question"):
            main.validate_presentation({
                "screen": "listing",
                "title": "Quizshow",
                "teams": [],
                "questionSelection": {
                    "questions": [{
                        "id": "pets", "displayCategory": "Zusammenleben", "completed": False,
                    }],
                    "selectedQuestion": {"id": "pets", "title": "Haustiere"},
                },
            })


if __name__ == "__main__":
    unittest.main()
