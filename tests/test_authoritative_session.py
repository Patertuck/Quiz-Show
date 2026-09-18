import json
import unittest
from pathlib import Path

from pydantic import ValidationError

from quizshow.domain.commands import (
    AdjustScore,
    MarkRulesShown,
    Navigate,
    ReplaceGameState,
    SetRoundPhase,
    StartSession,
    apply_command,
)
from quizshow.domain.config import QuizConfig
from quizshow.domain.projections import ClientRole, project_session
from quizshow.domain.session import HostScreen, QuizSession, SessionPhase, Team
from quizshow.session_service import SessionService, StaleSessionError


class FixedClock:
    def now(self) -> float:
        return 1_800_000_000.0


class AuthoritativeSessionTests(unittest.TestCase):
    def started(self) -> QuizSession:
        return apply_command(
            QuizSession.empty("family-night"),
            StartSession(type="start-session", teams=[Team(name="Rot"), Team(name="Blau", score=100)]),
            1_800_000_000.0,
        )

    def test_commands_return_new_validated_sessions(self):
        original = self.started()
        scored = apply_command(original, AdjustScore(
            type="adjust-score", team_index=0, amount=200, game="jeopardy", award_id="tile-1",
        ), 1_800_000_001.0)

        self.assertEqual(0, original.teams[0].score)
        self.assertEqual(200, scored.teams[0].score)
        self.assertEqual([200, 100], scored.score_history[-1].scores)
        self.assertIn("tile-1", scored.applied_awards)
        self.assertEqual(original.revision + 1, scored.revision)
        with self.assertRaisesRegex(ValueError, "already applied"):
            apply_command(scored, AdjustScore(
                type="adjust-score", team_index=0, amount=200, award_id="tile-1",
            ), 1_800_000_002.0)

    def test_navigation_rules_and_round_deadlines_are_server_state(self):
        session = self.started()
        session = apply_command(session, Navigate(type="navigate", screen=HostScreen.ORDERING), 1_800_000_001.0)
        session = apply_command(session, MarkRulesShown(type="mark-rules-shown", game="ordering"), 1_800_000_002.0)
        session = apply_command(session, SetRoundPhase(
            type="set-round-phase", game="ordering", phase=SessionPhase.ACTIVE,
            deadline_at=1_800_000_030.0,
        ), 1_800_000_003.0)

        self.assertEqual("ordering", session.active_game)
        self.assertEqual(SessionPhase.ACTIVE, session.phase)
        self.assertEqual(1_800_000_030.0, session.timer_deadlines["ordering"])
        self.assertIn("ordering", session.shown_rule_game_ids)
        with self.assertRaisesRegex(ValueError, "future"):
            apply_command(session, SetRoundPhase(
                type="set-round-phase", game="ordering", phase=SessionPhase.ACTIVE,
                deadline_at=1_700_000_000.0,
            ), 1_800_000_004.0)

    def test_service_rejects_stale_instance_and_revision(self):
        session = self.started()
        service = SessionService(FixedClock(), session)
        with self.assertRaises(StaleSessionError):
            service.execute(Navigate(type="navigate", screen=HostScreen.HUB),
                            instance_name="other", expected_revision=session.revision)
        with self.assertRaises(StaleSessionError):
            service.execute(Navigate(type="navigate", screen=HostScreen.HUB),
                            instance_name=session.instance_name, expected_revision=99)

        updated = service.execute(Navigate(type="navigate", screen=HostScreen.HUB),
                                  instance_name=session.instance_name, expected_revision=session.revision)
        self.assertEqual(session.revision + 1, updated.revision)

    def test_service_does_not_publish_candidate_when_persistence_fails(self):
        class FailingRepository:
            def write_session(self, _session):
                raise OSError("disk full")

        session = self.started()
        service = SessionService(FixedClock(), session, FailingRepository())
        with self.assertRaisesRegex(OSError, "disk full"):
            service.execute(AdjustScore(type="adjust-score", team_index=0, amount=100),
                            instance_name=session.instance_name, expected_revision=session.revision)

        self.assertEqual(0, service.snapshot(ClientRole.HOST)["teams"][0]["score"])
        self.assertEqual(session.revision, service.snapshot(ClientRole.HOST)["revision"])

    def test_restored_expired_round_moves_to_review(self):
        session = self.started()
        session = apply_command(session, SetRoundPhase(
            type="set-round-phase", game="sync", phase=SessionPhase.ACTIVE,
            deadline_at=1_700_000_000.0,
        ), 1_600_000_000.0)
        service = SessionService(FixedClock(), session)

        self.assertTrue(service.expire_due_round())
        restored = service.snapshot(ClientRole.HOST)
        self.assertEqual("review", restored["phase"])
        self.assertNotIn("sync", restored["timer_deadlines"])

    def test_role_projections_remove_private_game_data(self):
        session = self.started()
        session = apply_command(session, ReplaceGameState(type="replace-game-state", game="sync", state={
            "prompt": "Wer?", "answer": "Geheim", "votes": [{"deviceId": "phone-1"}],
            "validationRule": "intern",
        }), 1_800_000_001.0)

        host = project_session(session, ClientRole.HOST)
        player = project_session(session, ClientRole.PLAYER)
        display = project_session(session, ClientRole.DISPLAY)

        self.assertIn("votes", host["games"]["sync"])
        self.assertNotIn("votes", player["games"]["sync"])
        self.assertNotIn("answer", player["games"]["sync"])
        self.assertNotIn("votes", display["games"]["sync"])
        self.assertIn("answer", display["games"]["sync"])
        self.assertNotIn("applied_awards", player)

    def test_session_invariants_reject_inconsistent_history(self):
        with self.assertRaisesRegex(ValidationError, "score history"):
            QuizSession(
                instance_name="broken", teams=[Team(name="Rot", score=10)],
                score_history=[{"scores": [0]}],
            )


class BackendQuizConfigTests(unittest.TestCase):
    def test_committed_example_is_valid(self):
        payload = json.loads(Path("quiz-data/variations/beispiel-quiz/quiz-config.json").read_text(encoding="utf-8"))
        config = QuizConfig.model_validate(payload)

        self.assertTrue(config.title)
        self.assertIsNotNone(config.games.jeopardy)
        self.assertIsNotNone(config.games.ordering)
        self.assertIsNotNone(config.games.listing)
        self.assertIsNotNone(config.games.sync)

    def test_unknown_or_empty_games_are_rejected(self):
        base = {"title": "Quiz", "teams": [{"name": "Rot", "startingScore": 0}]}
        for games in ({}, {"unknown": {}}):
            with self.subTest(games=games), self.assertRaises(ValidationError):
                QuizConfig.model_validate({**base, "games": games})

    def test_duplicate_team_and_question_ids_are_rejected(self):
        with self.assertRaises(ValidationError):
            QuizConfig.model_validate({
                "title": "Quiz",
                "teams": [{"name": "Rot", "startingScore": 0}, {"name": "rot", "startingScore": 10}],
                "games": {"sync": {
                    "timeLimitSeconds": 10, "pointsPerSync": 100,
                    "questions": [{"id": "same", "prompt": "A"}, {"id": "SAME", "prompt": "B"}],
                }},
            })


if __name__ == "__main__":
    unittest.main()
