import http.client
import threading
import unittest
from pathlib import Path

import main


class StaticCacheTests(unittest.TestCase):
    def setUp(self):
        self.server = main.LocalQuizServer(("127.0.0.1", 0), main.QuizRequestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request("GET", path, headers={"Host": "127.0.0.1", **(headers or {})})
        response = connection.getresponse()
        body = response.read()
        result = response.status, response.headers, body
        connection.close()
        return result

    def test_static_files_revalidate_and_return_304_when_unchanged(self):
        status, headers, body = self.request("/js/app.js")
        self.assertEqual(200, status)
        self.assertTrue(body)
        self.assertEqual("no-cache, max-age=0, must-revalidate", headers["Cache-Control"])
        self.assertIsNotNone(headers["Last-Modified"])

        status, headers, body = self.request(
            "/js/app.js", {"If-Modified-Since": headers["Last-Modified"]},
        )
        self.assertEqual(304, status)
        self.assertEqual(b"", body)
        self.assertEqual("no-cache, max-age=0, must-revalidate", headers["Cache-Control"])

    def test_api_responses_remain_no_store(self):
        status, headers, _body = self.request("/api/live-state")
        self.assertEqual(200, status)
        self.assertEqual("no-store", headers["Cache-Control"])

    def test_frontend_sources_have_no_manual_version_parameters(self):
        roots = [Path("index.html"), Path("display.html"), Path("player.html"), Path("js"), Path("styles")]
        files = []
        for root in roots:
            files.extend(root.rglob("*") if root.is_dir() else [root])
        offenders = [
            str(path) for path in files
            if path.is_file() and path.suffix in {".html", ".js", ".css"}
            and "?v=" in path.read_text(encoding="utf-8")
        ]
        self.assertEqual([], offenders)


if __name__ == "__main__":
    unittest.main()
