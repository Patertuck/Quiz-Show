import unittest

import main


def saved_state(version=3):
    state = {
        "version": version,
        "updatedAt": "2026-08-15T10:00:00Z",
        "revision": 1,
        "gameStarted": True,
        "teams": [{"name": "Rot", "score": 300}, {"name": "Blau", "score": -100}],
        "usedTiles": [],
        "activeQuestion": None,
        "appliedAwards": [],
    }
    if version == 3:
        state["scoreHistory"] = [
            {"scores": [0, 0]},
            {"scores": [300, 0]},
            {"scores": [300, -100]},
        ]
    if version >= 4:
        state["scoreHistory"] = [
            {"scores": [0, 0], "game": None},
            {"scores": [300, -100], "game": "jeopardy"},
        ]
        state["scoreHistoryGame"] = "jeopardy"
    if version >= 5:
        state["shownRuleGameIds"] = ["jeopardy", "listing"]
    return state


class SavedScoreHistoryTests(unittest.TestCase):
    def test_accepts_complete_score_history(self):
        clean = main.validate_state(saved_state())
        self.assertEqual([[0, 0], [300, 0], [300, -100]], [entry["scores"] for entry in clean["scoreHistory"]])

    def test_migrates_version_two_from_current_scores(self):
        clean = main.validate_state(saved_state(version=2))
        self.assertEqual(3, clean["version"])
        self.assertEqual([{"scores": [300, -100]}], clean["scoreHistory"])

    def test_migrates_version_four_with_no_rules_shown(self):
        clean = main.validate_state(saved_state(version=4))
        self.assertEqual(5, clean["version"])
        self.assertEqual([], clean["shownRuleGameIds"])

    def test_accepts_unique_rule_game_ids(self):
        clean = main.validate_state(saved_state(version=5))
        self.assertEqual(["jeopardy", "listing"], clean["shownRuleGameIds"])

    def test_rejects_duplicate_or_unknown_rule_game_ids(self):
        for game_ids in (["listing", "listing"], ["unknown"]):
            state = saved_state(version=5)
            state["shownRuleGameIds"] = game_ids
            with self.subTest(game_ids=game_ids), self.assertRaisesRegex(ValueError, "shownRuleGameIds"):
                main.validate_state(state)

    def test_rejects_history_with_wrong_team_count(self):
        state = saved_state()
        state["scoreHistory"][1]["scores"] = [300]
        with self.assertRaisesRegex(ValueError, "one integer score per team"):
            main.validate_state(state)

    def test_rejects_history_that_does_not_end_at_current_score(self):
        state = saved_state()
        state["scoreHistory"][-1]["scores"] = [200, -100]
        with self.assertRaisesRegex(ValueError, "must match"):
            main.validate_state(state)


class ScoreHistoryPresentationTests(unittest.TestCase):
    def test_accepts_score_history_presentation(self):
        clean = main.validate_presentation({
            "screen": "score-history",
            "title": "Quizshow",
            "teams": [{"name": "Rot", "score": 300}, {"name": "Blau", "score": -100}],
            "scoreHistory": [{"scores": [0, 0]}, {"scores": [300, -100]}],
        })
        self.assertEqual(2, len(clean["scoreHistory"]))

    def test_rejects_score_history_presentation_with_missing_team_score(self):
        with self.assertRaisesRegex(ValueError, "one integer score per team"):
            main.validate_presentation({
                "screen": "score-history",
                "title": "Quizshow",
                "teams": [{"name": "Rot", "score": 300}, {"name": "Blau", "score": -100}],
                "scoreHistory": [{"scores": [300]}],
            })


if __name__ == "__main__":
    unittest.main()
