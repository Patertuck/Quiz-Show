import tempfile
import unittest
from pathlib import Path

from instance_state import InstanceStateStore
from main import OrderingState


QUESTION = {
    "id": "letters",
    "title": "Letters",
    "prompt": "Sort the letters.",
    "timeLimitSeconds": 60,
    "pointsPerCorrect": 50,
    "items": ["A", "B", "C", "D"],
}


class OrderingStateTests(unittest.TestCase):
    def make_state(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        state = OrderingState(InstanceStateStore(Path(temporary.name) / "state.json"))
        state.configure(["Rot", "Blau"], ["letters"])
        return state

    @staticmethod
    def set_orders(state, orders):
        with state.condition:
            state.round["teamOrders"] = orders

    def test_relative_scoring_counts_each_correct_pair_once(self):
        state = self.make_state()
        state.start(QUESTION)
        self.assertEqual("relative", state.round["scoringMode"])
        self.set_orders(state, [
            ["item-0", "item-2", "item-1", "item-3"],
            ["item-3", "item-2", "item-1", "item-0"],
        ])

        self.assertNotIn("rowPoints", state.snapshot("public")["round"])
        state.control({"action": "lock"})
        state.control({"action": "reveal", "slot": 2})
        snapshot = state.snapshot("public")["round"]
        self.assertNotIn("rowPoints", snapshot)
        self.assertNotIn("roundPoints", snapshot)

        state.control({"action": "reveal", "slot": 0})
        state.control({"action": "reveal", "slot": 1})
        state.control({"action": "reveal", "slot": 3})
        with self.assertRaisesRegex(ValueError, "Zeigt die Punkte"):
            state.awards()
        state.control({"action": "reveal-points"})
        snapshot = state.snapshot("public")["round"]
        self.assertEqual([[150, 50, 50, 0], [0, 0, 0, 0]], snapshot["rowPoints"])
        self.assertEqual([250, 0], snapshot["roundPoints"])
        self.assertEqual([250, 0], [award["points"] for award in state.awards()["awards"]])

    def test_timer_accepts_any_positive_integer(self):
        state = self.make_state()
        state.start({**QUESTION, "timeLimitSeconds": 1_000_000})
        self.assertEqual(1_000_000, state.snapshot("host")["round"]["timeLimitSeconds"])
        for invalid in (0, -1, 1.5, True, None):
            fresh = self.make_state()
            with self.assertRaisesRegex(ValueError, "positive Ganzzahl"):
                fresh.start({**QUESTION, "timeLimitSeconds": invalid})

    def test_correct_relative_order_receives_maximum(self):
        state = self.make_state()
        state.start({**QUESTION, "scoringMode": "relative"})
        correct = ["item-0", "item-1", "item-2", "item-3"]
        self.set_orders(state, [correct, correct])
        state.control({"action": "lock"})
        for slot in range(4):
            state.control({"action": "reveal", "slot": slot})
        self.assertNotIn("rowPoints", state.snapshot("host")["round"])
        state.control({"action": "reveal-points"})
        snapshot = state.snapshot("host")["round"]
        self.assertEqual([150, 100, 50, 0], snapshot["rowPoints"][0])
        self.assertEqual([300, 300], snapshot["roundPoints"])

    def test_exact_mode_preserves_position_scoring(self):
        state = self.make_state()
        state.start({**QUESTION, "scoringMode": "exact"})
        self.set_orders(state, [
            ["item-0", "item-2", "item-1", "item-3"],
            ["item-3", "item-2", "item-1", "item-0"],
        ])
        state.control({"action": "lock"})
        for slot in range(4):
            state.control({"action": "reveal", "slot": slot})
        state.control({"action": "reveal-points"})
        snapshot = state.snapshot("host")["round"]
        self.assertEqual([50, 0, 0, 50], snapshot["rowPoints"][0])
        self.assertEqual([100, 0], snapshot["roundPoints"])

    def test_invalid_scoring_mode_is_rejected(self):
        state = self.make_state()
        with self.assertRaisesRegex(ValueError, "scoringMode"):
            state.start({**QUESTION, "scoringMode": "distance"})

    def test_persisted_round_without_mode_keeps_legacy_exact_scoring(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "state.json"
        state = OrderingState(InstanceStateStore(path))
        state.configure(["Rot"], ["letters"])
        state.start(QUESTION)
        self.set_orders(state, [["item-0", "item-2", "item-1", "item-3"]])
        with state.condition:
            del state.round["scoringMode"]
            state._save_unlocked()

        loaded = OrderingState(InstanceStateStore(path))
        self.assertEqual("exact", loaded.snapshot("host")["round"]["scoringMode"])
        loaded.control({"action": "lock"})
        for slot in range(4):
            loaded.control({"action": "reveal", "slot": slot})
        loaded.control({"action": "reveal-points"})
        self.assertEqual([100], loaded.snapshot("host")["round"]["roundPoints"])

    def test_points_cannot_be_revealed_before_every_answer(self):
        state = self.make_state()
        state.start(QUESTION)
        state.control({"action": "lock"})
        state.control({"action": "reveal", "slot": 0})
        with self.assertRaisesRegex(ValueError, "alle Antworten"):
            state.control({"action": "reveal-points"})
        with self.assertRaisesRegex(ValueError, "Zeigt die Punkte"):
            state.control({"action": "confirm-distribution"})

    def test_round_can_be_cancelled_until_points_are_distributed(self):
        state = self.make_state()
        state.start(QUESTION)
        state.control({"action": "cancel"})
        self.assertIsNone(state.snapshot("host")["round"])

        state.start(QUESTION)
        state.control({"action": "lock"})
        state.control({"action": "cancel"})
        self.assertIsNone(state.snapshot("host")["round"])

        state.start(QUESTION)
        state.control({"action": "lock"})
        state.control({"action": "reveal", "slot": 0})
        state.control({"action": "cancel"})
        self.assertIsNone(state.snapshot("host")["round"])

        state.start(QUESTION)
        state.control({"action": "lock"})
        for slot in range(len(QUESTION["items"])):
            state.control({"action": "reveal", "slot": slot})
        state.control({"action": "reveal-points"})
        state.control({"action": "confirm-distribution"})
        with self.assertRaisesRegex(ValueError, "verteilten Punkten"):
            state.control({"action": "cancel"})

    def test_completed_question_can_be_reopened(self):
        state = self.make_state()
        state.completed.append(QUESTION["id"])

        state.control({"action": "reopen-question", "questionId": QUESTION["id"]})

        self.assertNotIn(QUESTION["id"], state.snapshot("host")["completedQuestionIds"])
        state.start(QUESTION)

    def test_only_completed_question_can_be_reopened(self):
        state = self.make_state()
        with self.assertRaisesRegex(ValueError, "nicht abgeschlossen"):
            state.control({"action": "reopen-question", "questionId": QUESTION["id"]})


if __name__ == "__main__":
    unittest.main()
