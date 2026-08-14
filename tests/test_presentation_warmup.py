import unittest

import main


class PresentationWarmupTests(unittest.TestCase):
    def test_accepts_warmup_question(self):
        clean = main.validate_presentation({
            "screen": "warmup-question", "title": "Quizshow", "teams": [],
            "questionIndex": 1, "questionCount": 2, "questionText": "Testfrage?", "concealedImageCount": 0,
        })

        self.assertEqual(clean["questionText"], "Testfrage?")
        self.assertEqual(clean["questionIndex"], 1)

    def test_rejects_warmup_position_outside_question_count(self):
        with self.assertRaisesRegex(ValueError, "position"):
            main.validate_presentation({
                "screen": "warmup-question", "title": "Quizshow", "teams": [],
                "questionIndex": 2, "questionCount": 2, "questionText": "Testfrage?", "concealedImageCount": 0,
            })

    def test_rejects_empty_warmup_question(self):
        with self.assertRaisesRegex(ValueError, "text"):
            main.validate_presentation({
                "screen": "warmup-question", "title": "Quizshow", "teams": [],
                "questionIndex": 0, "questionCount": 2, "questionText": "   ", "concealedImageCount": 0,
            })

    def test_accepts_three_concealed_images(self):
        clean = main.validate_presentation({
            "screen": "warmup-question", "title": "Quizshow", "teams": [],
            "questionIndex": 4, "questionCount": 5, "questionText": "Benenne die Krankheiten.",
            "concealedImageCount": 3,
        })

        self.assertEqual(clean["concealedImageCount"], 3)


if __name__ == "__main__":
    unittest.main()
