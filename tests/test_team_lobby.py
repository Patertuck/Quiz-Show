import unittest

import main


class TeamLobbyStateTests(unittest.TestCase):
    def setUp(self):
        self.lobby = main.TeamLobbyState()
        self.lobby.initialize({
            "teams": [
                {"name": "Team 1", "currentScore": 300, "startingScore": 0},
                {"name": "Team 2", "currentScore": 100, "startingScore": 0},
            ],
        })

    def player(self, device, action, **extra):
        status, result = self.lobby.player_control({
            "deviceId": device, "action": action, **extra
        })
        self.assertEqual(200, status)
        return result

    def test_players_create_and_join_a_team(self):
        created = self.player("device-owner", "create", name="  Die   Sieger  ")
        owned_id = created["ownedTeamId"]
        self.assertEqual(owned_id, created["selectedTeamId"])
        self.assertEqual("Die Sieger", created["teams"][-1]["name"])

        joined = self.player("device-member", "join", teamId=owned_id)
        self.assertEqual(owned_id, joined["selectedTeamId"])
        self.assertEqual(2, joined["teams"][-1]["memberCount"])

        self.assertNotIn("currentScore", joined["teams"][-1])

    def test_player_cannot_rename_or_remove_teams(self):
        created = self.player("device-owner", "create", name="Die Sieger")
        owned_id = created["ownedTeamId"]
        for action in ("rename", "remove"):
            with self.assertRaisesRegex(ValueError, "Unbekannte Team-Lobby-Aktion"):
                self.lobby.player_control({
                    "deviceId": "device-owner", "action": action,
                    "teamId": owned_id, "name": "Geändert",
                })

    def test_names_are_unique_and_one_team_per_device(self):
        with self.assertRaisesRegex(ValueError, "bereits verwendet"):
            self.player("device-owner", "create", name="team 1")
        self.player("device-owner", "create", name="Team 3")
        with self.assertRaisesRegex(ValueError, "bereits ein Team"):
            self.player("device-owner", "create", name="Team 4")

    def test_player_can_switch_then_create_a_team(self):
        teams = self.lobby.snapshot()["teams"]
        first = self.player("device-player", "join", teamId=teams[0]["id"])
        self.assertEqual(teams[0]["id"], first["selectedTeamId"])
        second = self.player("device-player", "join", teamId=teams[1]["id"])
        self.assertEqual(teams[1]["id"], second["selectedTeamId"])
        created = self.player("device-player", "create", name="Neues Team")
        self.assertEqual(created["ownedTeamId"], created["selectedTeamId"])

    def test_host_can_edit_scores_remain_private(self):
        team_id = self.lobby.snapshot("host")["teams"][0]["id"]
        host = self.lobby.host_control({"action": "rename", "teamId": team_id, "name": "Rot"})
        self.assertEqual(300, host["teams"][0]["currentScore"])
        public = self.lobby.snapshot()
        self.assertNotIn("currentScore", public["teams"][0])
        self.assertNotIn("startingScore", public["teams"][0])

    def test_lock_rejects_mutations_and_unlock_recovers(self):
        locked = self.lobby.host_control({"action": "lock"})
        self.assertEqual("locked", locked["phase"])
        status, _ = self.lobby.player_control({
            "deviceId": "device-owner", "action": "join", "teamId": locked["teams"][0]["id"]
        })
        self.assertEqual(409, status)
        self.lobby.host_control({"action": "unlock"})
        self.player("device-owner", "join", teamId=locked["teams"][0]["id"])

    def test_enforces_team_limit(self):
        for number in range(3, 13):
            self.lobby.host_control({"action": "add", "name": f"Team {number}"})
        with self.assertRaisesRegex(ValueError, "höchstens 12"):
            self.lobby.host_control({"action": "add", "name": "Team 13"})


class TeamLobbyPresentationTests(unittest.TestCase):
    def test_accepts_team_lobby_presentation(self):
        clean = main.validate_presentation({
            "screen": "team-lobby", "title": "Quizshow", "teams": [],
            "joinUrl": "https://quiz.example/player",
        })
        self.assertEqual("https://quiz.example/player", clean["joinUrl"])

    def test_rejects_invalid_team_lobby_join_url(self):
        with self.assertRaisesRegex(ValueError, "Team lobby join URL"):
            main.validate_presentation({
                "screen": "team-lobby", "title": "Quizshow", "teams": [],
                "joinUrl": "https://quiz.example/host",
            })


if __name__ == "__main__":
    unittest.main()
