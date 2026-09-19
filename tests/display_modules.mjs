import assert from "node:assert/strict";
import test from "node:test";

import { displaySceneKey, scoreChanges } from "../js/display/scene.js";

test("display scene keys describe the meaningful activity phase", () => {
  assert.equal(displaySceneKey({ screen: "ordering" }, { ordering: { round: { id: 4, phase: "active" } } }), "ordering:4:active");
  assert.equal(displaySceneKey({ screen: "sync" }, { sync: { rosterLocked: false } }), "sync:lobby");
  assert.equal(displaySceneKey({ screen: "jeopardy-question", question: { id: "q1", answerRevealed: true } }), "jeopardy-question:q1:answer");
});

test("score changes retain old and new values", () => {
  assert.deepEqual(scoreChanges(
    { teams: [{ score: 10 }, { score: 4 }] },
    { teams: [{ score: 15 }, { score: 1 }] }
  ), [
    { teamIndex: 0, points: 5, oldScore: 10, newScore: 15 },
    { teamIndex: 1, points: -3, oldScore: 4, newScore: 1 }
  ]);
});
