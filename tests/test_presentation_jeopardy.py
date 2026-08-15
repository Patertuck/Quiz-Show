import unittest

import main


class PresentationJeopardyTests(unittest.TestCase):
    def board(self, highlighted_tile=None):
        return {
            "screen": "jeopardy-board",
            "title": "Quizshow",
            "teams": [],
            "board": {
                "categories": ["A", "B"],
                "values": [100, 200],
                "usedTiles": ["0:1"],
                "highlightedTile": highlighted_tile,
            },
        }

    def test_accepts_available_highlighted_tile(self):
        clean = main.validate_presentation(self.board("1:0"))

        self.assertEqual("1:0", clean["board"]["highlightedTile"])

    def test_accepts_board_without_highlight(self):
        clean = main.validate_presentation(self.board())

        self.assertIsNone(clean["board"]["highlightedTile"])

    def test_rejects_used_highlighted_tile(self):
        with self.assertRaisesRegex(ValueError, "unavailable"):
            main.validate_presentation(self.board("0:1"))

    def test_rejects_out_of_range_highlighted_tile(self):
        with self.assertRaisesRegex(ValueError, "unavailable"):
            main.validate_presentation(self.board("2:0"))


if __name__ == "__main__":
    unittest.main()
