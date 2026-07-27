import tempfile
import unittest
from pathlib import Path

from sync_game import SyncState


class SyncStateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "sync-state.json"
        self.state = SyncState(self.path)
        self.state.configure("fingerprint", ["Rot", "Blau", "Grün"], ["q1", "q2"])

    def tearDown(self):
        self.temp.cleanup()

    def register(self, device, team, name):
        status, payload = self.state.register({
            "deviceId": device,
            "teamsRevision": self.state.teams_revision,
            "teamIndex": team,
            "name": name,
        })
        self.assertEqual(status, 200)
        return payload["participantId"]

    def prepare_and_start(self, question_id="q1"):
        self.state.control({"action": "prepare", "question": {
            "id": question_id, "prompt": "Wer?", "timeLimitSeconds": 5,
        }})
        self.state.control({"action": "start"})
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
            "teamIndex": 1,
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
            "teamIndex": 0,
            "name": "David",
        })
        self.assertEqual(status, 409)

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
        self.assertEqual(snapshot["syncTotals"], [1, 0, 1])
        self.assertTrue(snapshot["round"]["results"][0]["synced"])
        self.assertFalse(snapshot["round"]["results"][1]["synced"])
        self.assertTrue(snapshot["round"]["results"][2]["synced"])
        status, _ = self.state.vote({
            "deviceId": "device-0001", "roundId": round_id, "selectedParticipantId": anna,
        })
        self.assertEqual(status, 409)
        self.assertEqual(self.state.snapshot()["syncTotals"], [1, 0, 1])

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

    def test_competition_ranking_and_awards(self):
        with self.state.condition:
            self.state.sync_totals = [4, 4, 2]
            self.state.completed = ["q1"]
            self.state.finished = True
            self.state._changed_unlocked()
        standings = self.state.snapshot()["standings"]
        self.assertEqual([item["rank"] for item in standings], [1, 1, 3])
        award = self.state.awards([300, 200, 100])
        by_team = {item["teamIndex"]: item["points"] for item in award["awards"]}
        self.assertEqual(by_team, {0: 300, 1: 300, 2: 100})

    def test_state_persists_and_reset_uses_a_new_award_id(self):
        self.register("device-0001", 0, "Anna")
        self.register("device-0002", 1, "Beat")
        self.register("device-0003", 2, "Clara")
        with self.state.condition:
            self.state.completed = ["q1"]
            self.state.finished = True
            self.state._changed_unlocked()
        first_award = self.state.awards([300, 200, 100])["awardId"]
        loaded = SyncState(self.path)
        self.assertEqual(len(loaded.participants), 3)
        self.assertTrue(loaded.finished)
        loaded.control({"action": "reset-game"})
        with loaded.condition:
            loaded.completed = ["q1"]
            loaded.finished = True
            loaded._changed_unlocked()
        self.assertNotEqual(first_award, loaded.awards([300, 200, 100])["awardId"])

    def test_host_can_seed_and_vote_test_players(self):
        self.register("real-device-0001", 0, "Anna")
        snapshot = self.state.control({"action": "seed-test-players"})
        self.assertEqual(len([item for item in snapshot["participants"] if item["teamIndex"] == 0]), 1)
        self.assertEqual(len([item for item in snapshot["participants"] if item["teamIndex"] == 1]), 2)
        self.assertTrue(all(item["isTest"] for item in snapshot["participants"] if item["teamIndex"] == 1))
        self.state.control({"action": "lock-roster"})
        round_id = self.prepare_and_start()
        self.state.vote({
            "deviceId": "real-device-0001",
            "roundId": round_id,
            "selectedParticipantId": next(item["id"] for item in snapshot["participants"] if item["teamIndex"] == 0),
        })
        self.state.control({"action": "vote-test-players"})
        result = self.expire()
        self.assertEqual(result["syncTotals"], [1, 1, 1])


if __name__ == "__main__":
    unittest.main()
