"""Checks for optional server capabilities that are required in production."""

from importlib.util import find_spec


def require_websocket_runtime() -> None:
    if find_spec("websockets") is None and find_spec("wsproto") is None:
        raise RuntimeError(
            "WebSocket support is not installed. Run "
            ".\\.venv\\Scripts\\python.exe -m pip install -e \".[test]\" and restart the server."
        )
