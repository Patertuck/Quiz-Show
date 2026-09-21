import tempfile
import time
import unittest
from pathlib import Path

from instance_state import InstanceStateStore
from listing_game import ListingState

QUESTION = {
    "id": "pets",
    "title": "Haustiere",
    "prompt": "Nennt Haustiere.",
    "timeLimitSeconds": 60,
    "placementPoints": [300, 200, 100],
}


def wait_until(state, phase):
    deadline = time.time() + 2
    while time.time() < deadline:
        snapshot = state.snapshot("host")
        if snapshot["round"]["phase"] == phase:
            return snapshot
        time.sleep(0.01)
    raise AssertionError(f"Phase {phase} wurde nicht erreicht.")


class ListingStateTests(unittest.TestCase):
    def make_state(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        state = ListingState(InstanceStateStore(Path(temporary.name) / "state.json"))
        state.configure(["Rot", "Blau"], ["pets"])
        return state

    @staticmethod
    def submit(state, team_index, items, submit=False):
        snapshot = state.snapshot("host")
        return state.update_submission({
            "roundId": snapshot["round"]["id"],
            "teamsRevision": snapshot["teamsRevision"],
            "teamIndex": team_index,
            "items": items,
            "submit": submit,
        })

    def test_manual_review_ranking_and_awards(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "Katze", "Tiger", "hund"])
        self.submit(state, 1, ["Hund"], True)
        state.control({"action": "lock"})
        snapshot = wait_until(state, "review")
        self.assertEqual(["Hund", "Katze", "Tiger"], snapshot["round"]["drafts"][0])
        self.assertNotIn("drafts", state.snapshot("public")["round"])
        self.assertNotIn("reason", state.snapshot("host")["round"]["review"])

        queue_items = []
        for team_index in (0, 1):
            state.control({"action": "review-team", "teamIndex": team_index})
            review = state.snapshot("host")["round"]["review"]
            for item in review["items"]:
                queue_items.append(item["text"])
                state.control({"action": "decide", "itemId": item["itemId"],
                               "accepted": item["text"] in {"Hund", "Katze"}})
        state.control({"action": "finish-review"})

        self.assertEqual(["Hund", "Katze", "Tiger", "Hund"], queue_items)
        results = state.snapshot("host")["round"]["results"]
        self.assertEqual(
            [(0, 2, 1, 300), (1, 1, 2, 200)],
            [(item["teamIndex"], item["acceptedCount"], item["place"], item["points"]) for item in results],
        )
        self.assertEqual(
            [
                {"itemId": "t0-i0", "text": "Hund", "status": "counted", "accepted": True},
                {"itemId": "t0-i1", "text": "Katze", "status": "counted", "accepted": True},
                {"itemId": "t0-i2", "text": "Tiger", "status": "rejected", "accepted": False},
            ],
            results[0]["items"],
        )
        self.assertEqual({"mode": "ranking", "teamPosition": 0}, state.snapshot("public")["round"]["resultView"])
        public_item = state.snapshot("public")["round"]["results"][0]["items"][0]
        self.assertEqual({"text", "status"}, set(public_item))
        awards = state.awards()
        self.assertEqual("listing:", awards["awardId"][:8])
        self.assertEqual([300, 200], [item["points"] for item in awards["awards"]])

    def test_timer_accepts_any_positive_integer(self):
        state = self.make_state()
        state.start({**QUESTION, "timeLimitSeconds": 1_000_000})
        self.assertEqual(1_000_000, state.snapshot("host")["round"]["timeLimitSeconds"])
        for invalid in (0, -1, 1.5, True, None):
            fresh = self.make_state()
            with self.assertRaisesRegex(ValueError, "positive Ganzzahl"):
                fresh.start({**QUESTION, "timeLimitSeconds": invalid})

    def test_every_item_is_sent_to_manual_review(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "Katze"])
        state.control({"action": "lock"})
        snapshot = wait_until(state, "review")
        self.assertEqual(2, snapshot["round"]["review"]["total"])
        self.assertEqual(["Hund", "Katze"], [item["text"] for item in snapshot["round"]["review"]["items"]])
        self.assertNotIn("itemId", state.snapshot("public")["round"]["review"]["items"][0])
        self.assertNotIn("warning", snapshot["round"])
        self.assertNotIn("warning", state.snapshot("public")["round"])

    def test_submission_has_no_entry_count_limit(self):
        state = self.make_state()
        state.start(QUESTION)
        items = [f"Antwort {index}" for index in range(75)]

        status, _payload = self.submit(state, 0, items)
        state.control({"action": "lock"})

        self.assertEqual(200, status)
        self.assertEqual(75, state.snapshot("host")["round"]["review"]["total"])

    def test_empty_teams_receive_no_placement_points(self):
        state = self.make_state()
        state.start(QUESTION)
        state.control({"action": "lock"})
        snapshot = wait_until(state, "results")
        self.assertEqual([0, 0], [item["points"] for item in snapshot["round"]["results"]])

    def test_review_decision_can_be_revisited(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Katze", "Hund"])
        state.control({"action": "lock"})
        wait_until(state, "review")
        items = state.snapshot("host")["round"]["review"]["items"]
        state.control({"action": "decide", "itemId": items[0]["itemId"], "accepted": False})
        state.control({"action": "decide", "itemId": items[0]["itemId"], "accepted": True})
        state.control({"action": "decide", "itemId": items[1]["itemId"], "accepted": True})
        state.control({"action": "finish-review"})
        self.assertEqual(2, state.snapshot("host")["round"]["results"][0]["acceptedCount"])

    def test_wrong_answer_can_count_as_minus_one_or_zero(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "Stein"])
        self.submit(state, 1, ["Holz"])
        state.control({"action": "lock"})
        wait_until(state, "review")
        state.control({"action": "decide", "itemId": "t0-i0", "countImpact": 1})
        state.control({"action": "decide", "itemId": "t0-i1", "countImpact": -1})
        state.control({"action": "decide", "itemId": "t1-i0", "countImpact": 0})
        review = state.snapshot("host")["round"]["review"]
        self.assertEqual(0, review["teamValidCount"])
        self.assertEqual([0, 0], [team["validCount"] for team in review["teams"]])
        state.control({"action": "finish-review"})

        results = state.snapshot("host")["round"]["results"]
        by_team = {result["teamIndex"]: result for result in results}
        self.assertEqual(0, by_team[0]["acceptedCount"])
        self.assertEqual(0, by_team[1]["acceptedCount"])
        self.assertEqual("penalized", by_team[0]["items"][1]["status"])
        self.assertEqual("rejected", by_team[1]["items"][0]["status"])

    def test_duplicate_spelling_is_removed_before_review(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "hund"])
        state.control({"action": "lock"})
        snapshot = wait_until(state, "review")
        self.assertEqual(1, snapshot["round"]["review"]["total"])
        state.control({"action": "decide", "itemId": "t0-i0", "countImpact": 1})
        state.control({"action": "finish-review"})
        snapshot = state.snapshot("host")
        result = snapshot["round"]["results"][0]
        self.assertEqual(1, result["acceptedCount"])
        self.assertEqual(["counted"], [item["status"] for item in result["items"]])

    def test_results_can_be_cancelled_until_points_are_distributed(self):
        state = self.make_state()
        state.start(QUESTION)
        state.control({"action": "lock"})
        wait_until(state, "results")
        state.control({"action": "cancel"})
        self.assertIsNone(state.snapshot("host")["round"])

        state.start(QUESTION)
        state.control({"action": "lock"})
        wait_until(state, "results")
        state.control({"action": "confirm-distribution"})
        with self.assertRaisesRegex(ValueError, "verteilten Punkten"):
            state.control({"action": "cancel"})

    def test_review_can_be_cancelled(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund"])
        state.control({"action": "lock"})
        wait_until(state, "review")

        state.control({"action": "cancel"})

        self.assertIsNone(state.snapshot("host")["round"])

    def test_completed_question_can_be_reopened(self):
        state = self.make_state()
        state.completed.append("pets")
        state.control({"action": "reopen-question", "questionId": "pets"})
        self.assertNotIn("pets", state.snapshot("host")["completedQuestionIds"])
        state.start(QUESTION)
        self.assertEqual("active", state.snapshot("host")["round"]["phase"])


if __name__ == "__main__":
    unittest.main()
