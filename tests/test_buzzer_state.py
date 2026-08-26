import unittest

from main import BuzzerState


class BuzzerStateTests(unittest.TestCase):
    def setUp(self):
        self.state = BuzzerState()
        self.state.sync_teams({"teams": [
            {"name": "Rot"}, {"name": "Blau"}, {"name": "Grün"}
        ]})
        self.question_id = "0:0"
        self.state.control("open", self.question_id)

    def buzz(self, team_index):
        return self.state.buzz({
            "roundId": self.state.round_id,
            "teamsRevision": self.state.teams_revision,
            "teamIndex": team_index,
            "deviceId": f"device-{team_index}",
        })

    def test_removing_active_team_promotes_next_team(self):
        self.buzz(0)
        self.buzz(1)

        snapshot = self.state.control("remove", self.question_id, 0)

        self.assertEqual([buzz["teamIndex"] for buzz in snapshot["round"]["buzzes"]], [1])
        self.assertEqual(snapshot["round"]["activeTeamIndex"], 1)

    def test_removing_waiting_team_keeps_active_team(self):
        self.buzz(0)
        self.buzz(1)
        self.buzz(2)

        snapshot = self.state.control("remove", self.question_id, 1)

        self.assertEqual([buzz["teamIndex"] for buzz in snapshot["round"]["buzzes"]], [0, 2])
        self.assertEqual(snapshot["round"]["activeTeamIndex"], 0)

    def test_removed_team_can_buzz_again_at_end(self):
        self.buzz(0)
        self.buzz(1)
        self.state.control("remove", self.question_id, 0)

        status, response = self.buzz(0)

        self.assertEqual(status, 201)
        self.assertEqual(response["position"], 2)
        self.assertEqual([buzz["teamIndex"] for buzz in response["state"]["round"]["buzzes"]], [1, 0])

    def test_repeated_removal_is_safe(self):
        self.buzz(0)
        first = self.state.control("remove", self.question_id, 0)
        second = self.state.control("remove", self.question_id, 0)

        self.assertEqual(second["version"], first["version"])
        self.assertEqual(second["round"]["buzzes"], [])

    def test_removal_rejects_stale_question_and_invalid_team(self):
        with self.assertRaises(ValueError):
            self.state.control("remove", "1:0", 0)
        with self.assertRaises(ValueError):
            self.state.control("remove", self.question_id, 99)


if __name__ == "__main__":
    unittest.main()
