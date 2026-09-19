import unittest

from quizshow.game_services import GameServices


class FakeService:
    def __init__(self, name):
        self.name = name

    def snapshot(self, *args):
        return {"name": self.name, "args": list(args)}

    def __getattr__(self, operation):
        return lambda payload: (200, {"operation": operation, "payload": payload})


class GameServicesTests(unittest.TestCase):
    def setUp(self):
        self.services = GameServices(*(FakeService(name) for name in (
            "lobby", "buzzer", "ordering", "listing", "sync"
        )))

    def test_player_snapshots_apply_identity_consistently(self):
        snapshot = self.services.snapshots("player", "phone-1", 2)
        self.assertEqual(["player", "phone-1"], snapshot["teamLobby"]["args"])
        self.assertEqual(["team", 2], snapshot["ordering"]["args"])
        self.assertEqual(["player", "phone-1"], snapshot["sync"]["args"])

    def test_player_commands_share_one_dispatch_boundary(self):
        status, result = self.services.execute_player("listing", {"items": ["A"]})
        self.assertEqual(200, status)
        self.assertEqual("update_submission", result["operation"])

    def test_unknown_player_command_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown player command"):
            self.services.execute_player("unknown", {})


if __name__ == "__main__":
    unittest.main()
