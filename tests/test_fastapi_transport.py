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


if __name__ == "__main__":
    unittest.main()
