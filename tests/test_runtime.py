import unittest
from unittest.mock import patch

from quizshow.runtime import require_websocket_runtime


class RuntimeTests(unittest.TestCase):
    def test_accepts_either_supported_websocket_backend(self):
        with patch("quizshow.runtime.find_spec", side_effect=lambda name: object() if name == "websockets" else None):
            require_websocket_runtime()
        with patch("quizshow.runtime.find_spec", side_effect=lambda name: object() if name == "wsproto" else None):
            require_websocket_runtime()

    def test_missing_websocket_backend_has_actionable_error(self):
        with patch("quizshow.runtime.find_spec", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "pip install"):
                require_websocket_runtime()


if __name__ == "__main__":
    unittest.main()
