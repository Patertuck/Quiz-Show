import io
import http.client
import socketserver
import threading
import unittest
from email.message import Message
from unittest.mock import patch

import main


class FakeProcess:
    def __init__(self, output: str):
        self.stdout = io.StringIO(output)
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


def request_handler(host: str, forwarded: dict[str, str] | None = None):
    handler = object.__new__(main.QuizRequestHandler)
    handler.client_address = ("127.0.0.1", 12345)
    handler.headers = Message()
    handler.headers["Host"] = host
    for name, value in (forwarded or {}).items():
        handler.headers[name] = value
    return handler


class JoinInfoTests(unittest.TestCase):
    def tearDown(self):
        main.set_public_base_url(None)

    @patch("main.find_lan_address", return_value="192.168.1.25")
    def test_local_mode_uses_lan_urls(self, _find_address):
        main.set_public_base_url(None)

        info = main.current_join_info()

        self.assertEqual("local", info["mode"])
        self.assertEqual("http://192.168.1.25:8000/player", info["joinUrl"])
        self.assertEqual("http://192.168.1.25:8000/display", info["displayUrl"])

    @patch("main.find_lan_address", return_value="127.0.0.1")
    def test_public_mode_uses_https_tunnel_urls_without_requiring_lan(self, _find_address):
        main.set_public_base_url("https://quiet-river.trycloudflare.com/")

        info = main.current_join_info()

        self.assertEqual("public", info["mode"])
        self.assertEqual("https://quiet-river.trycloudflare.com/player", info["joinUrl"])
        self.assertEqual("https://quiet-river.trycloudflare.com/display", info["displayUrl"])
        self.assertFalse(info["lanAvailable"])


class HostAuthorizationTests(unittest.TestCase):
    def test_direct_loopback_request_is_host(self):
        self.assertTrue(request_handler("127.0.0.1:8000").is_host)
        self.assertTrue(request_handler("localhost:8000").is_host)

    def test_forwarded_loopback_request_is_not_host(self):
        handler = request_handler(
            "127.0.0.1:8000",
            {"CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.9"},
        )

        self.assertFalse(handler.is_host)

    def test_public_hostname_is_not_host_even_without_proxy_header(self):
        self.assertFalse(request_handler("quiet-river.trycloudflare.com").is_host)

    @patch.object(main.QUIZ_LIBRARY, "active_slot_id", return_value="current_save")
    def test_matching_query_slot_is_accepted(self, _active_slot):
        handler = request_handler("127.0.0.1:8000")
        handler.path = "/api/state?slot=current_save"

        self.assertTrue(handler.require_active_slot())

    @patch.object(main.QUIZ_LIBRARY, "active_slot_id", return_value="current_save")
    def test_stale_query_slot_is_rejected(self, _active_slot):
        handler = request_handler("127.0.0.1:8000")
        handler.path = "/api/state?slot=old_save"
        with patch.object(handler, "send_json") as send_json:
            self.assertFalse(handler.require_active_slot())
        send_json.assert_called_once_with(409, {"error": "Der aktive Spielstand wurde gewechselt."})

    @patch.object(main.QUIZ_LIBRARY, "active_slot_id", return_value="current_save")
    def test_missing_query_slot_is_rejected_for_host_mutations(self, _active_slot):
        handler = request_handler("127.0.0.1:8000")
        handler.path = "/api/state"
        with patch.object(handler, "send_json") as send_json:
            self.assertFalse(handler.require_active_slot())
        self.assertEqual(409, send_json.call_args.args[0])


class PresentationSessionTests(unittest.TestCase):
    def test_session_id_is_stable_for_one_server_and_changes_after_restart(self):
        with patch("main.time.time", side_effect=[1000.0, 1001.0]):
            first = main.PresentationState()
            restarted = main.PresentationState()
        original = first.snapshot()

        first.update({"screen": "standby", "title": "Quizshow", "teams": []})

        self.assertEqual(original["serverSessionId"], first.snapshot()["serverSessionId"])
        self.assertNotEqual(original["serverSessionId"], restarted.snapshot()["serverSessionId"])
        self.assertGreater(restarted.snapshot()["version"], original["version"])


class ServerDisconnectTests(unittest.TestCase):
    def test_expected_client_disconnect_does_not_print_a_traceback(self):
        server = object.__new__(main.LocalQuizServer)
        with patch.object(socketserver.BaseServer, "handle_error") as parent_handler:
            try:
                raise ConnectionAbortedError(10053, "client disconnected")
            except ConnectionAbortedError:
                server.handle_error(None, ("127.0.0.1", 12345))

        parent_handler.assert_not_called()

    def test_unexpected_server_error_is_still_reported(self):
        server = object.__new__(main.LocalQuizServer)
        with patch.object(socketserver.BaseServer, "handle_error") as parent_handler:
            try:
                raise RuntimeError("unexpected")
            except RuntimeError:
                server.handle_error(None, ("127.0.0.1", 12345))

        parent_handler.assert_called_once_with(None, ("127.0.0.1", 12345))


class PublicStaticFileTests(unittest.TestCase):
    def test_lan_display_can_load_game_catalog(self):
        server = main.LocalQuizServer(("127.0.0.1", 0), main.QuizRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            connection.request("GET", "/js/game-catalog.js", headers={"Host": "192.168.1.248:8000"})
            response = connection.getresponse()
            body = response.read()
            connection.close()

            self.assertEqual(200, response.status)
            self.assertIn(b"GAME_CATALOG", body)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class QuizLibraryAuthorizationTests(unittest.TestCase):
    def request(self, host):
        server = main.LocalQuizServer(("127.0.0.1", 0), main.QuizRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            connection.request("GET", "/api/quiz-library", headers={"Host": host})
            response = connection.getresponse()
            body = response.read()
            connection.close()
            return response.status, body
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_host_can_read_quiz_library(self):
        status, body = self.request("127.0.0.1:8000")
        self.assertEqual(200, status)
        self.assertIn(b"configurations", body)

    def test_lan_client_cannot_read_quiz_library(self):
        status, _ = self.request("192.168.1.248:8000")
        self.assertEqual(403, status)

    def test_lan_display_can_load_text_fitting_module(self):
        server = main.LocalQuizServer(("127.0.0.1", 0), main.QuizRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            connection.request("GET", "/js/fit-text.js", headers={"Host": "192.168.1.248:8000"})
            response = connection.getresponse()
            body = response.read()
            connection.close()

            self.assertEqual(200, response.status)
            self.assertIn(b"fitTextToContainer", body)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_lan_display_can_load_sound_module(self):
        server = main.LocalQuizServer(("127.0.0.1", 0), main.QuizRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            connection.request("GET", "/js/display-sounds.js?v=6", headers={"Host": "192.168.1.248:8000"})
            response = connection.getresponse()
            body = response.read()
            connection.close()

            self.assertEqual(200, response.status)
            self.assertIn(b"playBuzzerSound", body)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class QuickTunnelTests(unittest.TestCase):
    def tearDown(self):
        main.set_public_base_url(None)

    @patch("main.subprocess.Popen")
    def test_discovers_quick_tunnel_url_and_stops_process(self, popen):
        process = FakeProcess("INF Your quick Tunnel has been created! https://quiet-river.trycloudflare.com\n")
        popen.return_value = process
        tunnel = main.QuickTunnel()

        url = tunnel.start(timeout=1)
        tunnel.stop()

        self.assertEqual("https://quiet-river.trycloudflare.com", url)
        self.assertTrue(process.terminated)
        command = popen.call_args.args[0]
        self.assertEqual("cloudflared", command[0])
        self.assertIn("http://127.0.0.1:8000", command)

    @patch("main.subprocess.Popen", side_effect=FileNotFoundError)
    def test_missing_cloudflared_has_actionable_error(self, _popen):
        with self.assertRaisesRegex(RuntimeError, "winget install"):
            main.QuickTunnel().start(timeout=0.01)

    @patch("main.subprocess.Popen")
    def test_missing_url_terminates_tunnel_and_reports_failure(self, popen):
        process = FakeProcess("ERR tunnel registration failed\n")
        process.returncode = 1
        popen.return_value = process

        with self.assertRaisesRegex(RuntimeError, "did not provide a public URL"):
            main.QuickTunnel().start(timeout=0.1)


class FakeState:
    def __init__(self, teams=None):
        self.teams = teams or []
        self.snapshots = []
        self.touches = []

    def snapshot(self, *args):
        self.snapshots.append(args)
        return {"source": id(self), "args": args}

    def touch_poll_connection(self, *args):
        self.touches.append(args)


class LiveStateTests(unittest.TestCase):
    def test_player_snapshot_uses_team_and_device_roles_and_touches_presence(self):
        presentation = FakeState()
        buzzer = FakeState()
        ordering = FakeState(["Rot", "Blau"])
        listing = FakeState(["Rot", "Blau"])
        sync = FakeState(["Rot", "Blau"])
        team_lobby = FakeState()
        with patch.multiple(main, PRESENTATION=presentation, BUZZER=buzzer, ORDERING=ordering,
                            LISTING=listing, SYNC=sync, TEAM_LOBBY=team_lobby):
            result = main.live_state_snapshot(1, "device-0001", "client-0001")

        self.assertEqual({"presentation", "teamLobby", "buzzer", "ordering", "listing", "sync"}, set(result))
        self.assertEqual(("player", "device-0001"), team_lobby.snapshots[-1])
        self.assertEqual(("team", 1), ordering.snapshots[-1])
        self.assertEqual(("team", 1), listing.snapshots[-1])
        self.assertEqual(("player", "device-0001"), sync.snapshots[-1])
        self.assertEqual([("client-0001", 1)], ordering.touches)
        self.assertEqual([("client-0001", "device-0001")], sync.touches)

    def test_invalid_identity_receives_only_public_snapshots(self):
        ordering = FakeState(["Rot"])
        listing = FakeState(["Rot"])
        sync = FakeState(["Rot"])
        team_lobby = FakeState()
        with patch.multiple(main, PRESENTATION=FakeState(), BUZZER=FakeState(), ORDERING=ordering,
                            LISTING=listing, SYNC=sync, TEAM_LOBBY=team_lobby):
            main.live_state_snapshot(99, "short", "short")

        self.assertEqual((), team_lobby.snapshots[-1])
        self.assertEqual(("public", None), ordering.snapshots[-1])
        self.assertEqual(("public", None), listing.snapshots[-1])
        self.assertEqual(("public", None), sync.snapshots[-1])
        self.assertEqual([], ordering.touches)
        self.assertEqual([], sync.touches)


if __name__ == "__main__":
    unittest.main()
