"""Curated team colors shared by authoritative state and presentations."""

TEAM_COLORS = (
    {"id": "sun", "label": "Sonnengelb", "value": "#ffdd3c", "text": "#17206a"},
    {"id": "cyan", "label": "Cyan", "value": "#4de3ff", "text": "#17206a"},
    {"id": "rose", "label": "Rosa", "value": "#ff6384", "text": "#17206a"},
    {"id": "green", "label": "Grün", "value": "#70e36b", "text": "#17206a"},
    {"id": "violet", "label": "Violett", "value": "#bd7cff", "text": "#17206a"},
    {"id": "orange", "label": "Orange", "value": "#ff9f43", "text": "#17206a"},
    {"id": "blue", "label": "Blau", "value": "#45a3ff", "text": "#17206a"},
    {"id": "pink", "label": "Pink", "value": "#f368e0", "text": "#17206a"},
    {"id": "lime", "label": "Limette", "value": "#a3e635", "text": "#17206a"},
    {"id": "coral", "label": "Koralle", "value": "#ff6b35", "text": "#17206a"},
    {"id": "mint", "label": "Mint", "value": "#55efc4", "text": "#17206a"},
    {"id": "lavender", "label": "Lavendel", "value": "#c7d2fe", "text": "#17206a"},
)
TEAM_COLOR_IDS = frozenset(color["id"] for color in TEAM_COLORS)


def team_color(value: object) -> str:
    if not isinstance(value, str) or value not in TEAM_COLOR_IDS:
        raise ValueError("Diese Teamfarbe ist nicht verfügbar.")
    return value


def first_available(used: set[str]) -> str:
    color = next((item["id"] for item in TEAM_COLORS if item["id"] not in used), None)
    if color is None:
        raise ValueError("Es ist keine weitere Teamfarbe verfügbar.")
    return color
