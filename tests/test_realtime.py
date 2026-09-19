import asyncio
import tempfile
import time
import unittest
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

warnings.filterwarnings("ignore", category=DeprecationWarning, module="starlette.testclient")
from starlette.testclient import TestClient

from quizshow.app import create_app
from quizshow.container import ApplicationContainer
from quizshow.domain.session import QuizSession
from quizshow.settings import Settings
from quizshow.realtime import run_deadline_coordinator


class RealtimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "quiz-data" / "variations").mkdir(parents=True)
        (root / "quiz-data" / "instances").mkdir(parents=True)
        (root / "assets" / "Logos").mkdir(parents=True)
        self.container = ApplicationContainer.build(Settings(root))
        state_directory = root / "quiz-data" / "instances" / "quiz-night"
        state_directory.mkdir()
        self.container.state_store.switch(state_directory / "state.json")
        self.container.session.bind(QuizSession.empty("quiz-night"))
        self.app = create_app(container=self.container)

    def client(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            return TestClient(self.app, base_url="http://127.0.0.1")

    def test_host_command_validates_revision_and_persists_transition(self):
        with self.client() as client:
            response = client.post("/api/host/commands", json={
                "instanceName": "quiz-night",
                "expectedRevision": 0,
                "command": {
                    "type": "start-session",
                    "teams": [{"name": "Rot", "score": 0}, {"name": "Blau", "score": 100}],
                },
            })
            stale = client.post("/api/host/commands", json={
                "instanceName": "quiz-night", "expectedRevision": 0,
                "command": {"type": "navigate", "screen": "hub"},
            })

        self.assertEqual({"accepted": True, "revision": 1}, response.json())
        self.assertEqual(409, stale.status_code)
        self.assertEqual([0, 100], self.container.state_store.read_session().score_history[-1].scores)

    def test_websocket_sends_one_role_filtered_snapshot(self):
        with self.client() as client:
            with client.websocket_connect("/ws/live?role=display") as websocket:
                message = websocket.receive_json()

        self.assertEqual("snapshot", message["type"])
        self.assertEqual({"session", "presentation", "teamLobby", "buzzer", "ordering", "listing", "sync"},
                         set(message["data"]))
        self.assertNotIn("applied_awards", message["data"]["session"])

    def test_lan_websocket_cannot_claim_host_role(self):
        with self.client() as client:
            with self.assertRaises(Exception):
                with client.websocket_connect("ws://192.168.1.20/ws/live?role=host"):
                    pass

    def test_replacement_host_connection_restores_the_current_session(self):
        with self.client() as client:
            client.post("/api/host/commands", json={
                "instanceName": "quiz-night", "expectedRevision": 0,
                "command": {"type": "start-session", "teams": [{"name": "Rot", "score": 50}]},
            })
            client.post("/api/host/commands", json={
                "instanceName": "quiz-night", "expectedRevision": 1,
                "command": {"type": "set-round-phase", "game": "ordering", "phase": "active",
                            "deadline_at": 2_000_000_000},
            })
            with client.websocket_connect("/ws/live?role=host") as first:
                first_snapshot = first.receive_json()["data"]["session"]
            with client.websocket_connect("/ws/live?role=host") as replacement:
                replacement_snapshot = replacement.receive_json()["data"]["session"]

        self.assertEqual(first_snapshot, replacement_snapshot)
        self.assertEqual("ordering", replacement_snapshot["active_game"])
        self.assertEqual("active", replacement_snapshot["phase"])
        self.assertEqual(2, replacement_snapshot["revision"])

    def test_deadline_coordinator_broadcasts_without_a_client_command(self):
        class Deadlines:
            calls = 0

            def next_deadline_ms(self):
                self.calls += 1
                return int(time.time() * 1000) + 20 if self.calls == 1 else None

        app = SimpleNamespace(state=SimpleNamespace(deadline_changed=asyncio.Event()))

        async def exercise():
            broadcast_calls = []
            called = asyncio.Event()

            async def broadcast(current_app):
                broadcast_calls.append(current_app)
                called.set()

            with patch("quizshow.realtime.legacy_game_services", return_value=Deadlines()), \
                    patch("quizshow.realtime._broadcast", broadcast):
                task = asyncio.create_task(run_deadline_coordinator(app))
                try:
                    await asyncio.wait_for(called.wait(), timeout=0.5)
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
            self.assertEqual([app], broadcast_calls)

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
