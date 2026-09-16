import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateConfig } from "../js/store.js";
import { configuredGames, gameDefinition } from "../js/game-catalog.js";

const team = { name: "Team 1", startingScore: 0 };
const jeopardy = {
  values: [100],
  categories: [{
    name: "Test",
    questions: [{ question: "Frage", answer: "Antwort" }]
  }]
};
const ordering = {
  pointsPerCorrect: 100,
  questions: [{
    id: "order", title: "Order", prompt: "Sortieren", timeLimitSeconds: 30,
    items: ["A", "B", "C"]
  }]
};
const listing = {
  questions: [{
    id: "list", title: "List", displayCategory: "Kategorie", prompt: "Auflisten",
    validationRule: "Gültige Einträge", timeLimitSeconds: 30, maxItems: 10,
    placementPoints: [100]
  }]
};
const sync = {
  timeLimitSeconds: 8,
  pointsPerSync: 100,
  questions: [{ id: "sync", prompt: "Wer?" }]
};

function config(games) {
  return { title: "Quizshow", teams: [team], games };
}

test("accepts every supported game independently and together", () => {
  for (const [id, game] of Object.entries({ jeopardy, ordering, listing, sync })) {
    assert.equal(validateConfig(config({ [id]: game })).games[id], game);
  }
  assert.deepEqual(Object.keys(validateConfig(config({ jeopardy, ordering, listing, sync })).games),
    ["jeopardy", "ordering", "listing", "sync"]);
});

test("rejects no games, unknown games, and malformed present games", () => {
  assert.throws(() => validateConfig(config({})), /mindestens ein Spiel/);
  assert.throws(() => validateConfig(config({ trivia: {} })), /unbekanntes Spiel/);
  assert.throws(() => validateConfig(config({ listing: {} })), /listing\.questions/);
});

test("accepts relative and exact ordering scoring modes and rejects unknown modes", () => {
  assert.equal(validateConfig(config({ ordering })).games.ordering, ordering);
  assert.equal(validateConfig(config({ ordering: { ...ordering, scoringMode: "relative" } })).games.ordering.scoringMode, "relative");
  assert.equal(validateConfig(config({ ordering: { ...ordering, scoringMode: "exact" } })).games.ordering.scoringMode, "exact");
  assert.throws(
    () => validateConfig(config({ ordering: { ...ordering, scoringMode: "distance" } })),
    /scoringMode/
  );
});

test("allows jeopardy audio fields to be omitted or used as the only medium", () => {
  const audioOnly = {
    values: [100],
    categories: [{ name: "Audio", questions: [{
      questionAudio: { src: "assets/question.mp3", label: "Frage" },
      answerAudio: { src: "assets/answer.mp3", label: "Antwort" }
    }] }]
  };
  assert.equal(validateConfig(config({ jeopardy })).games.jeopardy, jeopardy);
  assert.equal(validateConfig(config({ jeopardy: audioOnly })).games.jeopardy, audioOnly);
});

test("uses instance logo overrides without changing the catalog defaults", () => {
  const logos = { jeopardy: "/quiz-logos/evening/Logo_Jeopardy.png" };
  assert.equal(gameDefinition("jeopardy", logos).logo, logos.jeopardy);
  assert.equal(configuredGames(config({ jeopardy }), logos)[0].logo, logos.jeopardy);
  assert.equal(gameDefinition("jeopardy").logo, "assets/Logos/Logo_Jeopardy.png");
});

test("the committed example quiz is a valid four-game variation", () => {
  const source = readFileSync(
    new URL("../quiz-data/variations/beispiel-quiz/quiz-config.json", import.meta.url),
    "utf8"
  );
  const example = validateConfig(JSON.parse(source));
  assert.deepEqual(Object.keys(example.games), ["jeopardy", "ordering", "listing", "sync"]);
});
