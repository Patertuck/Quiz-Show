import tempfile
import time
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from listing_game import GroqClassifier, ListingState


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
    def make_state(self, classifier):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        state = ListingState(Path(temporary.name) / "listing-state.json", classifier)
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

    def test_classification_review_ranking_and_awards(self):
        def classifier(_question, entries):
            verdicts = {
                "Hund": ("correct", "hund", "Sicher ein Haustier."),
                "Katze": ("uncertain", "katze", "Kontextabhängig."),
                "Tiger": ("wrong", "tiger", "Wildtier."),
            }
            return [
                {"id": entry["id"], "verdict": verdicts[entry["text"]][0],
                 "canonical": verdicts[entry["text"]][1], "reason": verdicts[entry["text"]][2]}
                for entry in entries
            ], None

        state = self.make_state(classifier)
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "Katze", "Tiger", "hund"])
        self.submit(state, 1, ["Hund"], True)
        state.control({"action": "lock"})
        snapshot = wait_until(state, "review")
        self.assertEqual(["Hund", "Katze", "Tiger"], snapshot["round"]["drafts"][0])
        self.assertNotIn("drafts", state.snapshot("public")["round"])
        self.assertNotIn("reason", state.snapshot("public")["round"]["review"])

        queue_items = []
        while state.snapshot("host")["round"]["phase"] == "review":
            review = state.snapshot("host")["round"]["review"]
            queue_items.append(review["text"])
            state.control({"action": "decide", "itemId": review["itemId"], "accepted": review["text"] == "Katze"})
            current = state.snapshot("host")["round"]
            if current["review"]["decidedCount"] == current["review"]["total"]:
                state.control({"action": "finish-review"})

        self.assertEqual(["Katze", "Tiger"], queue_items)
        results = state.snapshot("host")["round"]["results"]
        self.assertEqual(
            [(0, 2, 1, 300), (1, 1, 2, 200)],
            [(item["teamIndex"], item["acceptedCount"], item["place"], item["points"]) for item in results],
        )
        awards = state.awards()
        self.assertEqual("listing:", awards["awardId"][:8])
        self.assertEqual([300, 200], [item["points"] for item in awards["awards"]])

    def test_provider_failure_sends_every_item_to_review(self):
        attempts = 0

        def classifier(_question, entries):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("offline")
            return [
                {"id": entry["id"], "verdict": "correct", "canonical": entry["text"].casefold(), "reason": "ok"}
                for entry in entries
            ], None

        state = self.make_state(classifier)
        state.start(QUESTION)
        self.submit(state, 0, ["Hund", "Katze"])
        state.control({"action": "lock"})
        snapshot = wait_until(state, "review")
        self.assertEqual(2, snapshot["round"]["review"]["total"])
        self.assertIn("manuell geprüft", snapshot["round"]["warning"])
        self.assertNotIn("warning", state.snapshot("public")["round"])
        state.control({"action": "retry-ai"})
        recovered = wait_until(state, "results")
        self.assertEqual([2, 0], [item["acceptedCount"] for item in recovered["round"]["results"]])

    def test_empty_teams_receive_no_placement_points(self):
        state = self.make_state(lambda _question, _entries: ([], None))
        state.start(QUESTION)
        state.control({"action": "lock"})
        snapshot = wait_until(state, "results")
        self.assertEqual([0, 0], [item["points"] for item in snapshot["round"]["results"]])

    def test_review_decision_can_be_revisited(self):
        def classifier(_question, entries):
            return [
                {"id": entry["id"], "verdict": "uncertain", "canonical": entry["text"].casefold(), "reason": "Unsicher"}
                for entry in entries
            ], None

        state = self.make_state(classifier)
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


class GroqClassifierTests(unittest.TestCase):
    def test_request_uses_application_user_agent(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "server-config.json"
            config.write_text('{"groqApiKey":"secret","groqModel":"openai/gpt-oss-20b"}', encoding="utf-8")
            response_body = (
                b'{"choices":[{"message":{"content":"'
                b'{\\"items\\":{\\"a\\":{\\"verdict\\":\\"correct\\",'
                b'\\"canonical\\":\\"hund\\",\\"reason\\":\\"ok\\"}}}"}}]}'
            )

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

                def read(self):
                    return BytesIO(response_body).read()

            captured = {}

            def fake_urlopen(request, timeout):
                captured["user_agent"] = request.get_header("User-agent")
                captured["timeout"] = timeout
                return Response()

            with patch("urllib.request.urlopen", fake_urlopen):
                result, warning = GroqClassifier(config)(
                    {"prompt": "Haustiere", "validationRule": "Übliche Haustiere"},
                    [{"id": "a", "teamIndex": 0, "text": "Hund"}],
                )
            self.assertEqual("Quizshow/1.0 (+local-game)", captured["user_agent"])
            self.assertEqual("correct", result[0]["verdict"])
            self.assertIsNone(warning)


if __name__ == "__main__":
    unittest.main()
