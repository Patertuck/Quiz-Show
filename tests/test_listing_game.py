import tempfile
import time
import unittest
from pathlib import Path

from listing_game import ListingState


QUESTION = {
    "id": "pets",
    "title": "Haustiere",
    "prompt": "Nennt Haustiere.",
    "validationRule": "Übliche Haustiere sind richtig.",
    "timeLimitSeconds": 60,
    "maxItems": 10,
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
        state = ListingState(Path(temporary.name) / "listing-state.json")
        state.configure("fingerprint", ["Rot", "Blau"], ["pets"])
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
        while state.snapshot("host")["round"]["phase"] == "review":
            review = state.snapshot("host")["round"]["review"]
            queue_items.append(review["text"])
            state.control({"action": "decide", "itemId": review["itemId"],
                           "accepted": review["text"] in {"Hund", "Katze"}})
            current = state.snapshot("host")["round"]
            if current["review"]["decidedCount"] == current["review"]["total"]:
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
        self.assertEqual({"mode": "team", "teamPosition": 0}, state.snapshot("public")["round"]["resultView"])
        state.control({"action": "result-navigate", "teamPosition": 1})
        self.assertEqual(1, state.snapshot("public")["round"]["resultView"]["teamPosition"])
        state.control({"action": "result-ranking"})
        self.assertEqual("ranking", state.snapshot("public")["round"]["resultView"]["mode"])
        public_item = state.snapshot("public")["round"]["results"][0]["items"][0]
        self.assertEqual({"text", "status"}, set(public_item))
        awards = state.awards()
        self.assertEqual("listing:", awards["awardId"][:8])
        self.assertEqual([300, 200], [item["points"] for item in awards["awards"]])

    def test_every_item_is_sent_to_manual_review(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "Katze"])
        state.control({"action": "lock"})
        snapshot = wait_until(state, "review")
        self.assertEqual(2, snapshot["round"]["review"]["total"])
        self.assertNotIn("warning", snapshot["round"])
        self.assertNotIn("warning", state.snapshot("public")["round"])

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
        first = state.snapshot("host")["round"]["review"]
        state.control({"action": "decide", "itemId": first["itemId"], "accepted": False})
        state.control({"action": "navigate", "index": 0})
        state.control({"action": "decide", "itemId": first["itemId"], "accepted": True})
        state.control({"action": "navigate", "index": 1})
        second = state.snapshot("host")["round"]["review"]
        state.control({"action": "decide", "itemId": second["itemId"], "accepted": True})
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

    def test_result_items_can_toggle_between_correct_and_wrong(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "Stein"])
        state.control({"action": "lock"})
        wait_until(state, "review")
        state.control({"action": "decide", "itemId": "t0-i0", "countImpact": 1})
        state.control({"action": "decide", "itemId": "t0-i1", "countImpact": 0})
        state.control({"action": "finish-review"})

        state.control({"action": "toggle-result-item", "itemId": "t0-i0"})
        result = state.snapshot("host")["round"]["results"][0]
        self.assertEqual(0, result["acceptedCount"])
        self.assertEqual("rejected", result["items"][0]["status"])

        state.control({"action": "toggle-result-item", "itemId": "t0-i1"})
        result = state.snapshot("host")["round"]["results"][0]
        self.assertEqual(1, result["acceptedCount"])
        self.assertEqual("counted", result["items"][1]["status"])

    def test_result_items_cannot_change_after_distribution(self):
        state = self.make_state()
        state.start(QUESTION)
        self.submit(state, 0, ["Hund"])
        state.control({"action": "lock"})
        wait_until(state, "review")
        state.control({"action": "decide", "itemId": "t0-i0", "countImpact": 1})
        state.control({"action": "finish-review"})
        state.control({"action": "confirm-distribution"})

        with self.assertRaisesRegex(ValueError, "Punkteverteilung"):
            state.control({"action": "toggle-result-item", "itemId": "t0-i0"})

    def test_result_navigation_rejects_invalid_positions(self):
        state = self.make_state()
        state.start(QUESTION)
        state.control({"action": "lock"})
        wait_until(state, "results")
        with self.assertRaisesRegex(ValueError, "Ungültige Teamseite"):
            state.control({"action": "result-navigate", "teamPosition": 2})

    def test_completed_question_can_be_reopened(self):
        state = self.make_state()
        state.completed.append("pets")
        state.control({"action": "reopen-question", "questionId": "pets"})
        self.assertNotIn("pets", state.snapshot("host")["completedQuestionIds"])
        state.start(QUESTION)
        self.assertEqual("active", state.snapshot("host")["round"]["phase"])


if __name__ == "__main__":
    unittest.main()
