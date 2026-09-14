import unittest

from main import validate_presentation


def presentation_question(**overrides):
    question = {
        "id": "0:0",
        "value": 100,
        "question": "Welcher Song?",
        "questionImage": None,
        "questionAudio": {"src": "/quiz-content/test-quiz/assets/reverse-songs/test%20reverse.mp3", "label": "Rückwärtsversion"},
        "answerRevealed": False,
        "answer": None,
        "answerImage": None,
        "answerAudio": None,
        "audioCommand": None,
    }
    question.update(overrides)
    return {"screen": "jeopardy-question", "title": "Quizshow", "teams": [], "question": question}


class PresentationAudioTests(unittest.TestCase):
    def test_accepts_question_audio_and_play_command(self):
        clean = validate_presentation(presentation_question(
            audioCommand={"id": "command-1", "action": "play", "target": "question"}
        ))

        self.assertEqual("/quiz-content/test-quiz/assets/reverse-songs/test%20reverse.mp3", clean["question"]["questionAudio"]["src"])
        self.assertEqual("play", clean["question"]["audioCommand"]["action"])

    def test_hides_answer_audio_until_reveal(self):
        with self.assertRaisesRegex(ValueError, "unrevealed"):
            validate_presentation(presentation_question(
                answerAudio={"src": "/quiz-content/test-quiz/assets/reverse-songs/test%20normal.mp3", "label": "Originalversion"}
            ))

    def test_accepts_answer_audio_after_reveal(self):
        clean = validate_presentation(presentation_question(
            answerRevealed=True,
            answer="Der Song",
            answerAudio={"src": "/quiz-content/test-quiz/assets/reverse-songs/test%20normal.mp3", "label": "Originalversion"},
            audioCommand={"id": "command-2", "action": "restart", "target": "answer"},
        ))

        self.assertEqual("Originalversion", clean["question"]["answerAudio"]["label"])

    def test_rejects_unsafe_audio_path(self):
        with self.assertRaisesRegex(ValueError, "packaged quiz asset"):
            validate_presentation(presentation_question(
                questionAudio={"src": "assets/../secret.mp3", "label": "Falsch"}
            ))

    def test_rejects_command_for_missing_track(self):
        with self.assertRaisesRegex(ValueError, "no question audio"):
            validate_presentation(presentation_question(
                questionAudio=None,
                audioCommand={"id": "command-3", "action": "play", "target": "question"},
            ))


if __name__ == "__main__":
    unittest.main()
