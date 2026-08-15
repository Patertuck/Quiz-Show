import unittest

import main


class PresentationAudioSettingsTests(unittest.TestCase):
    @staticmethod
    def presentation(**extra):
        return {"screen": "standby", "title": "Quizshow", "teams": [], **extra}

    def test_defaults_all_audio_channels_to_enabled(self):
        clean = main.validate_presentation(self.presentation())

        self.assertEqual({
            "effectsEnabled": True,
            "tensionMusicEnabled": True,
            "ambientMusicEnabled": True,
        }, clean["audioSettings"])

    def test_accepts_independent_audio_channels(self):
        clean = main.validate_presentation(self.presentation(audioSettings={
            "effectsEnabled": False,
            "tensionMusicEnabled": True,
            "ambientMusicEnabled": False,
        }))

        self.assertEqual({
            "effectsEnabled": False,
            "tensionMusicEnabled": True,
            "ambientMusicEnabled": False,
        }, clean["audioSettings"])

    def test_rejects_non_boolean_audio_channel(self):
        with self.assertRaisesRegex(ValueError, "audio settings"):
            main.validate_presentation(self.presentation(audioSettings={
                "effectsEnabled": True,
                "tensionMusicEnabled": 1,
                "ambientMusicEnabled": True,
            }))


if __name__ == "__main__":
    unittest.main()
