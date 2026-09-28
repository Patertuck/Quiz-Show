import assert from "node:assert/strict";
import test from "node:test";

import { calculateFinalStatistics } from "../js/score-history-chart.js";

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
