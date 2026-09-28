import assert from "node:assert/strict";
import test from "node:test";

import { buildHighlightSlides, calculateFinalStatistics } from "../js/score-history-chart.js";

const teams = [
  { name: "Rot", score: 400, color: "sun" },
  { name: "Blau", score: 300, color: "cyan" },
  { name: "Grün", score: 150, color: "green" }
];
const history = [
  { scores: [0, 100, 0], game: null },
  { scores: [0, 300, 0], game: "jeopardy" },
  { scores: [300, 300, 0], game: "jeopardy" },
  { scores: [300, 200, 100], game: "ordering" },
  { scores: [400, 300, 100], game: "listing" },
  { scores: [400, 300, 150], game: null }
];

test("final statistics calculate awards, games, leads, and unlabelled changes", () => {
  const result = calculateFinalStatistics(teams, history, ["jeopardy", "ordering", "listing", "sync"]);
  assert.deepEqual(result.awards.biggestGain, { value: 300, teamIndices: [0], games: ["jeopardy"] });
  assert.deepEqual(result.awards.collector, { value: 400, teamIndices: [0] });
  assert.deepEqual(result.awards.comeback, { value: 300, teamIndices: [0] });
  assert.deepEqual(result.awards.gameWins, { value: 2, teamIndices: [0] });
  assert.equal(result.leadChanges, 2);
  assert.equal(result.winnerMargin, 100);
  assert.equal(result.hasOther, true);
  assert.deepEqual(result.teams[0].games, { jeopardy: 300, ordering: 0, listing: 100, sync: 0 });
  assert.equal(result.teams[2].other, 50);
  assert.equal(result.teams[0].netChange, 400);
  assert.deepEqual(result.gameSummaries.jeopardy, { netPoints: 500, percentage: 500 / 750 * 100, spread: 300 });
  assert.deepEqual(result.gameSummaries.ordering, { netPoints: 0, percentage: 0, spread: 200 });
  assert.deepEqual(result.gameSummaries.listing, { netPoints: 200, percentage: 200 / 750 * 100, spread: 100 });
  assert.deepEqual(result.gameSummaries.other, { netPoints: 50, percentage: 50 / 750 * 100, spread: 50 });
});

test("ties are retained and empty awards stay empty", () => {
  const tiedTeams = [{ name: "A", score: 0 }, { name: "B", score: 0 }];
  const result = calculateFinalStatistics(tiedTeams, [{ scores: [0, 0], game: null }], ["sync"]);
  assert.deepEqual([...result.winnerIndices], [0, 1]);
  assert.equal(result.winnerMargin, 0);
  assert.deepEqual(result.awards.biggestGain.teamIndices, []);
  assert.deepEqual(result.awards.gameWins.teamIndices, []);
  assert.equal(result.teams[0].rank, 1);
  assert.equal(result.teams[1].rank, 1);
  assert.deepEqual(result.gameSummaries.sync, { netPoints: 0, percentage: 0, spread: 0 });
});

test("rich analytics produce two fun, distinct highlight slides", () => {
  const events = [
    { id: "j1", type: "jeopardy-answer", questionId: "0:0", category: "Wissen", teamIndex: 0, points: 100, correct: true, responseMs: 420 },
    { id: "j2", type: "jeopardy-answer", questionId: "0:0", category: "Wissen", teamIndex: 1, points: -100, correct: false, responseMs: 900 },
    { id: "o1", type: "ordering-round", title: "Chronologie", teams: [{ teamIndex: 0, accuracy: 1 }, { teamIndex: 1, accuracy: 0.5 }] },
    { id: "l1", type: "listing-round", title: "Tiere", teams: [{ teamIndex: 0, accepted: 8, rejected: 1, duplicate: 0, penalized: 0 }] },
    { id: "s1", type: "sync-round", prompt: "Lieblingsessen", teams: [{ teamIndex: 0, synced: true }, { teamIndex: 1, synced: false }] }
  ];
  const slides = buildHighlightSlides(teams, history, ["jeopardy", "ordering", "listing", "sync"], events);
  assert.deepEqual(slides.map(({ id }) => id), ["team-awards", "quiz-records"]);
  assert.equal(slides[0].cards[0].title, "Schnellster Finger");
  assert.ok(slides[1].cards.some(({ title }) => title === "Buzzer-Schlacht"));
  assert.deepEqual(
    slides[1].cards.find(({ title }) => title === "Teuerster Irrtum"),
    { title: "Teuerster Irrtum", names: "Blau", value: "−100", detail: "Verlorene Punkte über das ganze Quiz" }
  );
  assert.ok(slides.every(({ cards }) => cards.length === 6));
  assert.ok(slides[0].cards.some(({ title, names, value, detail }) => title === "Ein-Spiel-Wunder" && names === "Rot & Grün" && value === "+100" && detail.includes("Jeopardy & Order Up")));
  assert.ok(slides[1].cards.some(({ title, names, value }) => title === "Nervenkrimi" && names === "List It" && value === "100"));
  assert.ok(slides.flatMap(({ cards }) => cards).every(({ title }) => !["Grösster Coup", "Jeopardy-Orakel", "Mut zur Lücke"].includes(title)));
});

test("highlight pages retain six playful facts when detailed analytics are missing", () => {
  const quietTeams = [{ name: "A", score: 0 }, { name: "B", score: 0 }];
  const slides = buildHighlightSlides(quietTeams, [{ scores: [0, 0], game: null }], ["jeopardy"], []);
  assert.ok(slides.every(({ cards }) => cards.length === 6));
  assert.equal(slides[0].cards.find(({ title }) => title === "Perfektionist").value, "–");
  assert.equal(slides[1].cards.find(({ title }) => title === "Teuerster Irrtum").names, "Keine Minuspunkte – erstaunlich");
  assert.equal(slides[1].cards.find(({ title }) => title === "Nervenkrimi").names, "Noch kein Spiel gewertet");
});
