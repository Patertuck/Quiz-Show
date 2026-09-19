import asyncio
import tempfile
import unittest
from pathlib import Path

import httpx

from quizshow.app import create_app
from quizshow.container import ApplicationContainer
from quizshow.settings import Settings


class FastApiTransportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "quiz-data" / "variations").mkdir(parents=True)
        (root / "quiz-data" / "instances").mkdir(parents=True)
        (root / "assets" / "Logos").mkdir(parents=True)
        # Static compatibility routes deliberately serve the real bundled UI.
        self.app = create_app(container=ApplicationContainer.build(Settings(root)))

    def request(self, method, path, *, base_url="http://127.0.0.1", **kwargs):
        async def run():
            async with self.app.router.lifespan_context(self.app):
                transport = httpx.ASGITransport(app=self.app)
                async with httpx.AsyncClient(transport=transport, base_url=base_url) as client:
                    return await client.request(method, path, **kwargs)

        return asyncio.run(run())

    def test_host_ui_and_compatibility_api_are_served_by_fastapi(self):
        index = self.request("GET", "/")
        presentation = self.request("GET", "/api/presentation/state")

        self.assertEqual(200, index.status_code)
        self.assertIn("text/html", index.headers["Content-Type"])
        self.assertEqual("no-cache, max-age=0, must-revalidate", index.headers["Cache-Control"])
        self.assertEqual(200, presentation.status_code)
        self.assertEqual("no-store", presentation.headers["Cache-Control"])

    def test_lan_clients_only_receive_player_and_display_resources(self):
        player = self.request("GET", "/player", base_url="http://192.168.1.20")
        host = self.request("GET", "/", base_url="http://192.168.1.20")
        library = self.request("GET", "/api/quiz-library", base_url="http://192.168.1.20")

        self.assertEqual(200, player.status_code)
        self.assertEqual(403, host.status_code)
        self.assertEqual(403, library.status_code)

    def test_path_traversal_and_unknown_api_are_rejected(self):
        self.assertIn(self.request("GET", "/..%2Fmain.py").status_code, {403, 404})
        self.assertEqual(404, self.request("GET", "/api/not-real").status_code)

    def test_requests_receive_a_traceable_request_id(self):
        generated = self.request("GET", "/api/health")
        supplied = self.request("GET", "/api/health", headers={"X-Request-ID": "test-request"})
        self.assertTrue(generated.headers["X-Request-ID"])
        self.assertEqual("test-request", supplied.headers["X-Request-ID"])

    def test_static_resources_are_revalidated_and_api_state_is_never_cached(self):
        script = self.request("GET", "/js/app.js")
        state = self.request("GET", "/api/buzzer/state")

        self.assertEqual("no-cache, max-age=0, must-revalidate", script.headers["Cache-Control"])
        self.assertEqual("no-store", state.headers["Cache-Control"])

    def test_ordering_and_listing_state_endpoints_return_json(self):
        for path in ("/api/ordering/state", "/api/listing/state"):
            with self.subTest(path=path):
                response = self.request("GET", path)
                self.assertEqual(200, response.status_code)
                self.assertIn("application/json", response.headers["Content-Type"])
                self.assertIsInstance(response.json(), dict)

    def test_lan_clients_can_load_all_player_module_dependencies(self):
        for path in (
            "/js/player.js", "/js/live-client.js", "/js/player/commands.js",
            "/js/player/identity.js", "/js/player/listing.js", "/js/player/live-session.js",
            "/js/player/ordering.js", "/js/player/sync.js",
        ):
            with self.subTest(path=path):
                self.assertEqual(200, self.request("GET", path, base_url="http://192.168.1.20").status_code)


if __name__ == "__main__":
    unittest.main()
