import unittest

import main


class PresentationStandbyTests(unittest.TestCase):
    def test_accepts_static_standby(self):
        clean = main.validate_presentation({"screen": "standby", "title": "Quizshow", "teams": []})
        self.assertEqual("standby", clean["screen"])
        self.assertEqual("/assets/Logos/logo_Quiz.png", clean["logos"]["main"])

    def test_accepts_safe_instance_logos_and_rejects_unsafe_sources(self):
        logos = {key: f"/quiz-logos/evening/{filename}"
                 for key, filename in main.LOGO_FILENAMES.items()}
        clean = main.validate_presentation({
            "screen": "standby", "title": "Quizshow", "teams": [], "logos": logos,
        })
        self.assertEqual(logos, clean["logos"])
        logos["main"] = "/quiz-logos/evening/../state.json"
        with self.assertRaisesRegex(ValueError, "logos"):
            main.validate_presentation({
                "screen": "standby", "title": "Quizshow", "teams": [], "logos": logos,
            })

    def test_rejects_removed_intro_and_warmup_screens(self):
        for screen in ("intro", "warmup-question"):
            with self.subTest(screen=screen), self.assertRaisesRegex(ValueError, "screen"):
                main.validate_presentation({"screen": screen, "title": "Quizshow", "teams": []})


if __name__ == "__main__":
    unittest.main()
