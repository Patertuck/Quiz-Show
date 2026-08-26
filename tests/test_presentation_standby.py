import unittest

import main


class PresentationStandbyTests(unittest.TestCase):
    def test_accepts_static_standby(self):
        clean = main.validate_presentation({"screen": "standby", "title": "Quizshow", "teams": []})
        self.assertEqual("standby", clean["screen"])

    def test_rejects_removed_intro_and_warmup_screens(self):
        for screen in ("intro", "warmup-question"):
            with self.subTest(screen=screen), self.assertRaisesRegex(ValueError, "screen"):
                main.validate_presentation({"screen": screen, "title": "Quizshow", "teams": []})


if __name__ == "__main__":
    unittest.main()
