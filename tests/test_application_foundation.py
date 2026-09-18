import asyncio
import tempfile
import unittest
from pathlib import Path

import httpx

from quizshow.app import create_app
from quizshow.container import ApplicationContainer
from quizshow.errors import ApplicationError
from quizshow.settings import Settings


class FakeClock:
    def now(self) -> float:
        return 1234.5


class ApplicationFoundationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "quiz-data" / "variations").mkdir(parents=True)
        (self.root / "quiz-data" / "instances").mkdir(parents=True)
        (self.root / "assets" / "Logos").mkdir(parents=True)
        self.settings = Settings(self.root, port=8123)

    def test_settings_resolve_project_paths(self):
        self.assertEqual(self.root.resolve() / "quiz-data", self.settings.quiz_data_directory)
        self.assertEqual(self.root.resolve() / "assets" / "Logos", self.settings.logo_directory)
        with self.assertRaisesRegex(ValueError, "port"):
            Settings(self.root, port=0)

    def test_containers_are_isolated_and_accept_injected_clock(self):
        first = ApplicationContainer.build(self.settings, clock=FakeClock())
        second = ApplicationContainer.build(self.settings, clock=FakeClock())

        self.assertIsNot(first.quiz_library, second.quiz_library)
        self.assertIsNot(first.state_store, second.state_store)
        self.assertIsNot(first.connections, second.connections)
        self.assertEqual(1234.5, first.clock.now())

    def test_registry_closes_connections_during_container_shutdown(self):
        class Connection:
            closed = False

            async def close(self):
                self.closed = True

        container = ApplicationContainer.build(self.settings)
        connection = Connection()

        async def exercise():
            await container.connections.add("display", connection)
            self.assertEqual(("display",), await container.connections.ids())
            await container.close()

        asyncio.run(exercise())
        self.assertTrue(connection.closed)

    def test_factory_exposes_health_and_uses_supplied_container(self):
        container = ApplicationContainer.build(self.settings)
        app = create_app(container=container)

        async def request():
            async with app.router.lifespan_context(app):
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                    return await client.get("/api/health")

        response = asyncio.run(request())

        self.assertEqual(200, response.status_code)
        self.assertEqual({"status": "ok", "active_instance": None}, response.json())

    def test_application_errors_use_stable_json_shape(self):
        app = create_app(self.settings)

        @app.get("/failure")
        def failure():
            raise ApplicationError("Kaputt", 409)

        async def request():
            async with app.router.lifespan_context(app):
                transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
                async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                    return await client.get("/failure")

        response = asyncio.run(request())

        self.assertEqual(409, response.status_code)
        self.assertEqual({"error": "Kaputt"}, response.json())
        self.assertEqual("no-store", response.headers["Cache-Control"])


if __name__ == "__main__":
    unittest.main()
