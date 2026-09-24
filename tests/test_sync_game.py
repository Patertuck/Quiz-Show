import tempfile
import unittest
from pathlib import Path

from instance_state import InstanceStateStore
from sync_game import SyncState


class SyncStateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "state.json"
        self.state = SyncState(InstanceStateStore(self.path))
        self.state.configure(["Rot", "Blau", "Grün"], ["q1", "q2"])
        self.state.control({"action": "standard-distribution"})

    def tearDown(self):
        self.temp.cleanup()

    def register(self, device, team, name):
        status, payload = self.state.register({
            "deviceId": device,
            "teamsRevision": self.state.teams_revision,
            "syncTeamId": self.state.sync_teams[team]["id"],
            "name": name,
        })
        self.assertEqual(status, 200)
        return payload["participantId"]

    def prepare_and_start(self, question_id="q1"):
        self.state.control({"action": "prepare", "question": {
            "id": question_id, "prompt": "Wer?", "timeLimitSeconds": 5, "pointsPerSync": 100,
        }})
        self.state.control({"action": "start", "timeLimitSeconds": 5})
        return self.state.snapshot("host")["round"]["id"]

    def expire(self):
        with self.state.condition:
            self.state.round["deadlineAt"] = 0
        return self.state.snapshot("public")

    def test_registration_is_unique_within_team_and_restores_by_device(self):
        participant_id = self.register("device-0001", 0, " Anna ")
        with self.assertRaisesRegex(ValueError, "bereits verwendet"):
            self.register("device-0002", 0, "anna")
        status, payload = self.state.register({
            "deviceId": "device-0001",
            "teamsRevision": self.state.teams_revision,
            "syncTeamId": self.state.sync_teams[1]["id"],
            "name": "Anni",
        })
        self.assertEqual(status, 200)
        self.assertEqual(payload["participantId"], participant_id)
        self.assertEqual(payload["state"]["selfParticipantId"], participant_id)

    def test_roster_requires_every_team_and_locks_new_devices(self):
        self.register("device-0001", 0, "Anna")
        with self.assertRaisesRegex(ValueError, "Mindestens eine Person fehlt"):
            self.state.control({"action": "lock-roster"})
        self.register("device-0002", 1, "Beat")
        self.register("device-0003", 2, "Céline")
        self.state.control({"action": "lock-roster"})
        status, _ = self.state.register({
            "deviceId": "device-0004",
            "teamsRevision": self.state.teams_revision,
            "syncTeamId": self.state.sync_teams[0]["id"],
            "name": "David",
        })
        self.assertEqual(status, 409)

    def test_inactive_account_can_be_reconnected_from_a_new_device(self):
        anna = self.register("device-0001", 0, "Anna")
        self.register("device-0002", 1, "Beat")
        self.register("device-0003", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        connection_id = self.state.connect("device-0001")
        status, payload = self.state.reconnect({
            "deviceId": "replacement-device",
            "participantId": anna,
            "syncTeamId": self.state.sync_teams[0]["id"],
            "teamsRevision": self.state.teams_revision,
        })
        self.assertEqual(status, 409)
        self.assertIn(anna, payload["state"]["connectedParticipantIds"])
        self.state.disconnect(connection_id)
        status, payload = self.state.reconnect({
            "deviceId": "replacement-device",
            "participantId": anna,
            "syncTeamId": self.state.sync_teams[0]["id"],
            "teamsRevision": self.state.teams_revision,
        })
        self.assertEqual(status, 200)
        self.assertEqual(payload["state"]["selfParticipantId"], anna)
        self.assertNotIn("selfParticipantId", self.state.snapshot("player", "device-0001"))

    def test_timer_accepts_any_positive_integer(self):
        question = self.state._validate_question({
            "id": "q1", "prompt": "Wer?", "timeLimitSeconds": 1_000_000, "pointsPerSync": 100,
        })
        self.assertEqual(1_000_000, question["timeLimitSeconds"])
        for invalid in (0, -1, 1.5, True, None):
            with self.assertRaisesRegex(ValueError, "positive Ganzzahl"):
                self.state._validate_question({
                    "id": "q1", "prompt": "Wer?", "timeLimitSeconds": invalid, "pointsPerSync": 100,
                })

    def test_start_can_override_prepared_timer(self):
        self.register("device-0001", 0, "Anna")
        self.register("device-0002", 1, "Beat")
        self.register("device-0003", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        self.state.control({"action": "prepare", "question": {
            "id": "q1", "prompt": "Wer?", "timeLimitSeconds": 5, "pointsPerSync": 100,
        }})
        with self.assertRaisesRegex(ValueError, "positive Ganzzahl"):
            self.state.control({"action": "start", "timeLimitSeconds": 0})
        self.state.control({"action": "start", "timeLimitSeconds": 123})
        round_state = self.state.snapshot("host")["round"]
        self.assertEqual(123, round_state["timeLimitSeconds"])
        self.assertEqual("active", round_state["phase"])

    def test_account_cannot_be_reconnected_through_another_team(self):
        anna = self.register("device-0001", 0, "Anna")
        with self.assertRaisesRegex(ValueError, "gehört nicht"):
            self.state.reconnect({
                "deviceId": "replacement-device",
                "participantId": anna,
                "syncTeamId": self.state.sync_teams[1]["id"],
                "teamsRevision": self.state.teams_revision,
            })

    def test_latest_votes_lock_and_synced_team_scores(self):
        anna = self.register("device-0001", 0, "Anna")
        alex = self.register("device-0002", 0, "Alex")
        beat = self.register("device-0003", 1, "Beat")
        bea = self.register("device-0004", 1, "Bea")
        clara = self.register("device-0005", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        round_id = self.prepare_and_start()

        for device, choice in [
            ("device-0001", anna),
            ("device-0001", alex),
            ("device-0002", alex),
            ("device-0003", beat),
            ("device-0004", bea),
            ("device-0005", clara),
        ]:
            status, _ = self.state.vote({
                "deviceId": device, "roundId": round_id, "selectedParticipantId": choice,
            })
            self.assertEqual(status, 200)

        snapshot = self.expire()
        self.assertTrue(snapshot["round"]["results"][0]["synced"])
        self.assertFalse(snapshot["round"]["results"][1]["synced"])
        self.assertTrue(snapshot["round"]["results"][2]["synced"])
        self.assertEqual([item["points"] for item in snapshot["round"]["results"]], [100, 0, 100])
        status, _ = self.state.vote({
            "deviceId": "device-0001", "roundId": round_id, "selectedParticipantId": anna,
        })
        self.assertEqual(status, 409)

    def test_missing_vote_prevents_sync_and_active_public_state_hides_votes(self):
        anna = self.register("device-0001", 0, "Anna")
        self.register("device-0002", 0, "Alex")
        self.register("device-0003", 1, "Beat")
        self.register("device-0004", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        round_id = self.prepare_and_start()
        self.state.vote({"deviceId": "device-0001", "roundId": round_id, "selectedParticipantId": anna})
        public = self.state.snapshot("public")
        self.assertNotIn("votes", public["round"])
        self.assertNotIn("ownSelectionId", public["round"])
        result = self.expire()
        self.assertFalse(result["round"]["results"][0]["synced"])

    def test_round_awards_are_100_or_zero_and_must_be_distributed_before_close(self):
        anna = self.register("device-0001", 0, "Anna")
        self.register("device-0002", 1, "Beat")
        clara = self.register("device-0003", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        round_id = self.prepare_and_start()
        self.state.vote({"deviceId": "device-0001", "roundId": round_id, "selectedParticipantId": anna})
        self.state.vote({"deviceId": "device-0003", "roundId": round_id, "selectedParticipantId": clara})
        self.expire()
        award = self.state.awards()
        by_team = {item["teamIndex"]: item["points"] for item in award["awards"]}
        self.assertEqual(by_team, {0: 100, 1: 0, 2: 100})
        self.assertEqual(award["awardId"], f"sync:{round_id}")
        with self.assertRaisesRegex(ValueError, "Verteilt zuerst"):
            self.state.control({"action": "close"})
        self.state.control({"action": "confirm-distribution"})
        self.assertEqual(self.state.snapshot()["round"]["phase"], "distributed")
        self.state.control({"action": "close"})

    def test_result_and_round_award_id_persist_across_reload(self):
        anna = self.register("device-0001", 0, "Anna")
        beat = self.register("device-0002", 1, "Beat")
        clara = self.register("device-0003", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        round_id = self.prepare_and_start()
        for device, selected in [
            ("device-0001", anna), ("device-0002", beat), ("device-0003", clara)
        ]:
            self.state.vote({"deviceId": device, "roundId": round_id, "selectedParticipantId": selected})
        self.expire()
        first_award = self.state.awards()
        loaded = SyncState(InstanceStateStore(self.path))
        self.assertEqual(len(loaded.participants), 3)
        self.assertEqual(loaded.snapshot()["round"]["phase"], "results")
        self.assertEqual(first_award, loaded.awards())
        loaded.control({"action": "confirm-distribution"})
        loaded.control({"action": "close"})
        loaded.control({"action": "prepare", "question": {
            "id": "q2", "prompt": "Wer noch?", "timeLimitSeconds": 5, "pointsPerSync": 100,
        }})
        loaded.control({"action": "start", "timeLimitSeconds": 5})
        self.assertNotEqual(round_id, loaded.snapshot()["round"]["id"])

    def test_host_can_seed_and_vote_test_players(self):
        self.register("real-device-0001", 0, "Anna")
        snapshot = self.state.control({"action": "seed-test-players"})
        first_id, second_id = self.state.sync_teams[0]["id"], self.state.sync_teams[1]["id"]
        self.assertEqual(len([item for item in snapshot["participants"] if item["syncTeamId"] == first_id]), 1)
        self.assertEqual(len([item for item in snapshot["participants"] if item["syncTeamId"] == second_id]), 2)
        self.assertTrue(all(item["isTest"] for item in snapshot["participants"] if item["syncTeamId"] == second_id))
        self.state.control({"action": "lock-roster"})
        round_id = self.prepare_and_start()
        self.state.vote({
            "deviceId": "real-device-0001",
            "roundId": round_id,
            "selectedParticipantId": next(item["id"] for item in snapshot["participants"] if item["syncTeamId"] == first_id),
        })
        self.state.control({"action": "vote-test-players"})
        result = self.expire()
        self.assertEqual([item["points"] for item in result["round"]["results"]], [100, 100, 100])

    def test_completed_prompt_can_be_reopened(self):
        self.state.completed.append("q1")

        self.state.control({"action": "reopen-question", "questionId": "q1"})

        self.assertNotIn("q1", self.state.snapshot("host")["completedQuestionIds"])

    def test_only_completed_prompt_can_be_reopened(self):
        with self.assertRaisesRegex(ValueError, "nicht abgeschlossen"):
            self.state.control({"action": "reopen-question", "questionId": "q1"})

    def test_players_create_join_and_rename_a_sync_team(self):
        self.state.control({"action": "reset-game"})
        status, created = self.state.player_team_control({
            "action": "create", "deviceId": "device-0001", "name": "Banana",
        })
        self.assertEqual(200, status)
        sync_team_id = created["syncTeamId"]
        self.state.register({
            "deviceId": "device-0001", "teamsRevision": self.state.teams_revision,
            "syncTeamId": sync_team_id, "name": "Anna",
        })
        self.state.register({
            "deviceId": "device-0002", "teamsRevision": self.state.teams_revision,
            "syncTeamId": sync_team_id, "name": "Beat",
        })
        status, renamed = self.state.player_team_control({
            "action": "rename", "deviceId": "device-0002",
            "syncTeamId": sync_team_id, "name": "Bananen",
        })
        self.assertEqual(200, status)
        self.assertEqual("Bananen", renamed["state"]["syncTeams"][0]["name"])

    def test_combined_sync_team_awards_every_mapped_quiz_team(self):
        banana = self.state.sync_teams[0]
        self.state.control({
            "action": "map-quiz-team", "quizTeamIndex": 1, "syncTeamId": banana["id"],
        })
        anna = self.register("device-0001", 0, "Anna")
        self.state.register({
            "deviceId": "device-0002", "teamsRevision": self.state.teams_revision,
            "syncTeamId": banana["id"], "name": "Beat",
        })
        self.register("device-0003", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        round_id = self.prepare_and_start()
        for device in ("device-0001", "device-0002"):
            self.state.vote({
                "deviceId": device, "roundId": round_id, "selectedParticipantId": anna,
            })
        self.expire()
        awards = {item["teamIndex"]: item["points"] for item in self.state.awards()["awards"]}
        self.assertEqual({0: 100, 1: 100, 2: 0}, awards)

    def test_host_can_delete_sync_team_and_its_registrations_before_lock(self):
        removed_team = self.state.sync_teams[0]
        self.register("device-0001", 0, "Anna")
        snapshot = self.state.control({
            "action": "delete-sync-team", "syncTeamId": removed_team["id"],
        })
        self.assertNotIn(removed_team["id"], [team["id"] for team in snapshot["syncTeams"]])
        self.assertEqual([], snapshot["participants"])
        with self.assertRaisesRegex(ValueError, "genau einem"):
            self.state.control({"action": "lock-roster"})

    def test_host_cannot_delete_sync_team_after_lock(self):
        self.register("device-0001", 0, "Anna")
        self.register("device-0002", 1, "Beat")
        self.register("device-0003", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        with self.assertRaisesRegex(ValueError, "gesperrt"):
            self.state.control({
                "action": "delete-sync-team", "syncTeamId": self.state.sync_teams[0]["id"],
            })

    def test_host_can_delete_participant_before_lock_but_not_after(self):
        anna = self.register("device-0001", 0, "Anna")
        self.state.connect("device-0001")
        snapshot = self.state.control({"action": "delete-participant", "participantId": anna})
        self.assertEqual([], snapshot["participants"])
        self.assertEqual({}, self.state.connections)

        self.register("device-0001", 0, "Anna")
        self.register("device-0002", 1, "Beat")
        clara = self.register("device-0003", 2, "Clara")
        self.state.control({"action": "lock-roster"})
        with self.assertRaisesRegex(ValueError, "gesperrt"):
            self.state.control({"action": "delete-participant", "participantId": clara})


if __name__ == "__main__":
    unittest.main()
