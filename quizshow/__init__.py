"""Quizzy backend package."""


def create_app(*args, **kwargs):
    """Import the web application lazily so domain modules stay dependency-light."""
    from .app import create_app as factory

    return factory(*args, **kwargs)


__all__ = ["create_app"]
