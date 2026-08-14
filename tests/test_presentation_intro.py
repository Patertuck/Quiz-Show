import unittest

import main


class PresentationIntroTests(unittest.TestCase):
    def test_accepts_intro_without_heads(self):
        clean = main.validate_presentation({
            "screen": "intro", "title": "Quizshow", "teams": [], "headsVisible": False,
        })

        self.assertFalse(clean["headsVisible"])

    def test_accepts_intro_with_heads(self):
        clean = main.validate_presentation({
            "screen": "intro", "title": "Quizshow", "teams": [], "headsVisible": True,
        })

        self.assertTrue(clean["headsVisible"])

    def test_rejects_intro_without_visibility_state(self):
        with self.assertRaisesRegex(ValueError, "headsVisible"):
            main.validate_presentation({"screen": "intro", "title": "Quizshow", "teams": []})


if __name__ == "__main__":
    unittest.main()
