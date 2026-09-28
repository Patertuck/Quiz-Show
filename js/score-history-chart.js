import { formatInteger } from "./format-number.js";
import { TEAM_COLORS, teamColor } from "./team-colors.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export const SCORE_HISTORY_COLORS = TEAM_COLORS.map(({ value }) => value);

const SCORE_HISTORY_GAME_LABELS = {
  jeopardy: "Jeopardy",
  ordering: "Order Up",
  listing: "List It",
  sync: "Sync Up",
  legacy: "Frühere Punkte"
};

export const FINAL_GAME_LABELS = Object.freeze({
  jeopardy: "Jeopardy", ordering: "Order Up", listing: "List It", sync: "Sync Up", other: "Sonstiges"
});

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function leaders(scores) {
  const maximum = Math.max(...scores);
  return new Set(scores.flatMap((score, index) => score === maximum ? [index] : []));
}

function finalRanks(teams) {
  const sorted = teams.map((team, index) => ({ index, score: team.score }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const ranks = Array(teams.length);
  let previousScore;
  let previousRank = 0;
  sorted.forEach((team, position) => {
    const rank = position === 0 || team.score < previousScore ? position + 1 : previousRank;
    ranks[team.index] = rank;
    previousScore = team.score;
    previousRank = rank;
  });
  return ranks;
}

function winners(values, target) {
  return values.flatMap((value, index) => value === target ? [index] : []);
}

export function calculateFinalStatistics(teams, history, configuredGameIds = []) {
  const safeHistory = history?.length ? history : [{ scores: teams.map(({ score }) => score), game: null }];
  const startingScores = safeHistory[0].scores;
  const grossPoints = teams.map(() => 0);
  const biggestGains = teams.map(() => 0);
  const biggestGainGames = teams.map(() => null);
  const gameTotals = Object.fromEntries(configuredGameIds.map((game) => [game, teams.map(() => 0)]));
  const activeGames = new Set();
  const otherTotals = teams.map(() => 0);
  let hasOther = false;
  let previousLeaders = leaders(startingScores);
  let leadChanges = 0;
  safeHistory.slice(1).forEach((entry, offset) => {
    const previous = safeHistory[offset];
    const game = entry.game && FINAL_GAME_LABELS[entry.game] ? entry.game : null;
    if (game && !gameTotals[game]) gameTotals[game] = teams.map(() => 0);
    if (game) activeGames.add(game);
    entry.scores.forEach((score, teamIndex) => {
      const change = score - previous.scores[teamIndex];
      if (change > 0) grossPoints[teamIndex] += change;
      if (change > biggestGains[teamIndex]) {
        biggestGains[teamIndex] = change;
        biggestGainGames[teamIndex] = game;
      }
      if (game) gameTotals[game][teamIndex] += change;
      else if (change !== 0) {
        otherTotals[teamIndex] += change;
        hasOther = true;
      }
    });
    const nextLeaders = leaders(entry.scores);
    if (!sameSet(previousLeaders, nextLeaders)) leadChanges += 1;
    previousLeaders = nextLeaders;
  });
  const maximumDeficits = teams.map((_, index) => Math.max(...startingScores) - startingScores[index]);
  const comebacks = teams.map(() => 0);
  safeHistory.slice(1).forEach((entry) => {
    const leaderScore = Math.max(...entry.scores);
    entry.scores.forEach((score, index) => {
      const deficit = leaderScore - score;
      comebacks[index] = Math.max(comebacks[index], maximumDeficits[index] - deficit);
      maximumDeficits[index] = Math.max(maximumDeficits[index], deficit);
    });
  });
  const gameWins = teams.map(() => 0);
  activeGames.forEach((game) => {
    const maximum = Math.max(...gameTotals[game]);
    winners(gameTotals[game], maximum).forEach((index) => { gameWins[index] += 1; });
  });
  const maximumGain = Math.max(0, ...biggestGains);
  const maximumGross = Math.max(0, ...grossPoints);
  const maximumComeback = Math.max(0, ...comebacks);
  const maximumWins = Math.max(0, ...gameWins);
  const orderedScores = [...new Set(teams.map(({ score }) => score))].sort((left, right) => right - left);
  const gameIds = [...new Set([...configuredGameIds, ...Object.keys(gameTotals)])]
    .filter((game) => FINAL_GAME_LABELS[game]);
  const ranks = finalRanks(teams);
  const summaryEntries = [
    ...gameIds.map((id) => ({ id, values: gameTotals[id] })),
    ...(hasOther ? [{ id: "other", values: otherTotals }] : [])
  ];
  const totalMagnitude = summaryEntries.reduce(
    (total, { values }) => total + Math.abs(values.reduce((sum, value) => sum + value, 0)), 0
  );
  const gameSummaries = Object.fromEntries(summaryEntries.map(({ id, values }) => {
    const netPoints = values.reduce((sum, value) => sum + value, 0);
    return [id, {
      netPoints,
      percentage: totalMagnitude ? Math.abs(netPoints) / totalMagnitude * 100 : 0,
      spread: values.length ? Math.max(...values) - Math.min(...values) : 0
    }];
  }));
  return {
    gameIds, gameSummaries, hasOther, leadChanges,
    winnerMargin: orderedScores.length > 1 ? orderedScores[0] - orderedScores[1] : 0,
    winnerIndices: leaders(teams.map(({ score }) => score)),
    awards: {
      biggestGain: { value: maximumGain, teamIndices: maximumGain > 0 ? winners(biggestGains, maximumGain) : [], games: maximumGain > 0 ? [...new Set(winners(biggestGains, maximumGain).map((index) => biggestGainGames[index]))] : [] },
      comeback: { value: maximumComeback, teamIndices: maximumComeback > 0 ? winners(comebacks, maximumComeback) : [] },
      collector: { value: maximumGross, teamIndices: maximumGross > 0 ? winners(grossPoints, maximumGross) : [] },
      gameWins: { value: maximumWins, teamIndices: maximumWins > 0 ? winners(gameWins, maximumWins) : [] }
    },
    teams: teams.map((team, index) => ({
      index, name: team.name, color: team.color, rank: ranks[index], finalScore: team.score,
      netChange: team.score - startingScores[index], grossPoints: grossPoints[index],
      biggestGain: biggestGains[index], comeback: comebacks[index], gameWins: gameWins[index],
      games: Object.fromEntries(gameIds.map((game) => [game, gameTotals[game]?.[index] || 0])),
      other: otherTotals[index]
    }))
  };
}

export function statisticTeamNames(statistics, indices) {
  return indices.map((index) => statistics.teams[index]?.name).filter(Boolean).join(" & ");
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

function niceStep(range, targetTicks = 5) {
  if (!range) return 1;
  const rough = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

export function createScoreHistoryChart(teams, history) {
  const section = document.createElement("section");
  section.className = "score-history-chart";
  const heading = document.createElement("h1");
  heading.textContent = "Punkteverlauf";

  const svg = svgElement("svg", { viewBox: "0 0 1200 650", role: "img", "aria-labelledby": "score-history-title score-history-description" });
  const title = svgElement("title", { id: "score-history-title" });
  title.textContent = "Punkteverlauf aller Teams";
  const description = svgElement("desc", { id: "score-history-description" });
  description.textContent = "Jede Linie zeigt den Punktestand eines Teams nach jeder Punkteänderung, gruppiert nach Spiel.";
  svg.append(title, description);

  const left = 105;
  const right = 1160;
  const top = 70;
  const bottom = 570;
  const scores = history.flatMap((entry) => entry.scores);
  const rawMin = Math.min(0, ...scores);
  const rawMax = Math.max(0, ...scores);
  const tickStep = niceStep(Math.max(1, rawMax - rawMin));
  let yMin = Math.floor(rawMin / tickStep) * tickStep;
  let yMax = Math.ceil(rawMax / tickStep) * tickStep;
  if (yMin === yMax) yMax = yMin + tickStep;
  const xAt = (index) => history.length === 1
    ? left
    : left + (index / (history.length - 1)) * (right - left);
  const yAt = (score) => bottom - ((score - yMin) / (yMax - yMin)) * (bottom - top);
  const transitionCount = Math.max(0, history.length - 1);
  const stepDuration = transitionCount ? Math.min(850, Math.max(120, 12000 / transitionCount)) : 0;
  const startDuration = 320;

  const gameRuns = [];
  history.slice(1).forEach((entry, offset) => {
    const index = offset + 1;
    const game = entry.game || "legacy";
    const previousRun = gameRuns.at(-1);
    if (previousRun?.game === game) previousRun.end = index;
    else gameRuns.push({ game, start: index, end: index });
  });

  gameRuns.forEach((run, runIndex) => {
    if (runIndex > 0) {
      const x = (xAt(run.start - 1) + xAt(run.start)) / 2;
      svg.append(svgElement("line", {
        class: "score-history-game-divider", x1: x, x2: x, y1: top - 28, y2: bottom
      }));
    }
    const label = svgElement("text", {
      class: "score-history-game-label",
      x: (xAt(run.start) + xAt(run.end)) / 2,
      y: top - 38,
      "text-anchor": "middle"
    });
    label.textContent = SCORE_HISTORY_GAME_LABELS[run.game] || run.game;
    svg.append(label);
  });

  for (let value = yMin; value <= yMax + tickStep / 2; value += tickStep) {
    const y = yAt(value);
    svg.append(svgElement("line", { class: `score-history-grid${value === 0 ? " zero" : ""}`, x1: left, x2: right, y1: y, y2: y }));
    const label = svgElement("text", { class: "score-history-y-label", x: left - 18, y: y + 7, "text-anchor": "end" });
    label.textContent = formatInteger(value);
    svg.append(label);
  }

  const labelEvery = Math.max(1, Math.ceil(history.length / 12));
  history.forEach((entry, index) => {
    if (index !== 0 && index !== history.length - 1 && index % labelEvery !== 0) return;
    const x = xAt(index);
    svg.append(svgElement("line", { class: "score-history-tick", x1: x, x2: x, y1: bottom, y2: bottom + 10 }));
    const label = svgElement("text", { class: "score-history-x-label", x, y: bottom + 38, "text-anchor": "middle" });
    label.textContent = index === 0 ? "Start" : String(index);
    svg.append(label);
  });

  teams.forEach((team, teamIndex) => {
    const color = teamColor(team.color, teamIndex).value;
    history.slice(1).forEach((entry, offset) => {
      const index = offset + 1;
      const delay = startDuration + offset * stepDuration;
      const segment = svgElement("line", {
        class: "score-history-segment",
        x1: xAt(index - 1), y1: yAt(history[index - 1].scores[teamIndex]),
        x2: xAt(index), y2: yAt(entry.scores[teamIndex]),
        stroke: color, pathLength: 1
      });
      segment.style.setProperty("--score-history-delay", `${delay}ms`);
      segment.style.setProperty("--score-history-duration", `${stepDuration}ms`);
      svg.append(segment);
    });
    history.forEach((entry, index) => {
      const delay = index === 0
        ? 0
        : startDuration + ((index - 1) * stepDuration) + (stepDuration * 0.82);
      const point = svgElement("circle", {
        class: `score-history-point${index === 0 ? " start" : ""}`,
        cx: xAt(index), cy: yAt(entry.scores[teamIndex]), r: 5, fill: color
      });
      point.style.setProperty("--score-history-delay", `${delay}ms`);
      if (index > 0) point.style.setProperty("--score-history-point-duration", `${Math.max(40, stepDuration * 0.18)}ms`);
      const pointTitle = svgElement("title");
      const gameLabel = index ? SCORE_HISTORY_GAME_LABELS[entry.game || "legacy"] : "Start";
      pointTitle.textContent = `${team.name}: ${formatInteger(entry.scores[teamIndex])} Punkte · ${gameLabel}`;
      point.append(pointTitle);
      svg.append(point);
    });
  });

  svg.append(
    svgElement("line", { class: "score-history-axis", x1: left, x2: left, y1: top, y2: bottom }),
    svgElement("line", { class: "score-history-axis", x1: left, x2: right, y1: bottom, y2: bottom })
  );

  const legend = document.createElement("div");
  legend.className = "score-history-legend";
  teams.forEach((team, index) => {
    const item = document.createElement("div");
    const swatch = document.createElement("i");
    swatch.style.background = teamColor(team.color, index).value;
    item.append(swatch, document.createTextNode(team.name));
    legend.append(item);
  });
  section.append(heading, svg, legend);
  return section;
}

function htmlElement(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function awardCard(label, names, value, detail = "") {
  const card = htmlElement("article", "final-highlight-card");
  card.append(htmlElement("h2", "", label), htmlElement("strong", "final-highlight-value", value), htmlElement("p", "final-highlight-names", names));
  if (detail) card.append(htmlElement("small", "", detail));
  return card;
}

export function createHighlightsView(teams, history, gameIds) {
  const statistics = calculateFinalStatistics(teams, history, gameIds);
  const section = htmlElement("section", "final-statistics final-highlights");
  section.append(htmlElement("h1", "", "Quiz-Highlights"));
  const cards = htmlElement("div", "final-highlight-grid");
  const biggest = statistics.awards.biggestGain;
  const biggestGames = biggest.games.filter(Boolean).map((game) => FINAL_GAME_LABELS[game]).join(" & ");
  cards.append(
    awardCard("Grösster Coup", statisticTeamNames(statistics, biggest.teamIndices) || "Kein Punktgewinn", biggest.value ? `+${formatInteger(biggest.value)}` : "–", biggestGames),
    awardCard("Stärkstes Comeback", statisticTeamNames(statistics, statistics.awards.comeback.teamIndices) || "Kein Comeback", statistics.awards.comeback.value ? formatInteger(statistics.awards.comeback.value) : "–", statistics.awards.comeback.value ? "Punkte Rückstand aufgeholt" : ""),
    awardCard("Punktesammler", statisticTeamNames(statistics, statistics.awards.collector.teamIndices) || "Keine Punkte gesammelt", statistics.awards.collector.value ? formatInteger(statistics.awards.collector.value) : "–", "Positive Punkte insgesamt"),
    awardCard("Meiste Spielsiege", statisticTeamNames(statistics, statistics.awards.gameWins.teamIndices) || "Noch kein Spiel gewertet", statistics.awards.gameWins.value ? formatInteger(statistics.awards.gameWins.value) : "–", statistics.awards.gameWins.value === 1 ? "Spielsieg" : "Spielsiege"),
    awardCard("Führungswechsel", "Im gesamten Quiz", formatInteger(statistics.leadChanges)),
    awardCard("Siegervorsprung", statisticTeamNames(statistics, [...statistics.winnerIndices]), formatInteger(statistics.winnerMargin), statistics.winnerMargin ? "Punkte" : "Geteilter erster Platz")
  );
  section.append(cards);
  return section;
}

function signed(value) {
  return value > 0 ? `+${formatInteger(value)}` : formatInteger(value);
}

function percentage(value) {
  return `${value.toFixed(1)}%`;
}

export function createGameBreakdownView(teams, history, gameIds) {
  const statistics = calculateFinalStatistics(teams, history, gameIds);
  const games = statistics.gameIds.map((id) => ({ id, label: FINAL_GAME_LABELS[id] }));
  if (statistics.hasOther) games.push({ id: "other", label: FINAL_GAME_LABELS.other });
  const maximum = Math.max(1, ...statistics.teams.flatMap((team) => games.map(({ id }) => Math.abs(id === "other" ? team.other : team.games[id]))));
  const section = htmlElement("section", "final-statistics final-game-breakdown");
  section.append(htmlElement("h1", "", "Spielvergleich"));
  const charts = htmlElement("div", "final-game-charts");
  charts.style.setProperty("--game-columns", String(games.length));
  games.forEach(({ id, label }) => {
    const chart = htmlElement("article", "final-game-chart");
    chart.append(htmlElement("h2", "", label));
    const summary = statistics.gameSummaries[id];
    const summaryRow = htmlElement("div", "final-game-summary");
    summaryRow.append(
      htmlElement("span", "", `Netto ${signed(summary.netPoints)}`),
      htmlElement("span", "", `Anteil ${percentage(summary.percentage)}`),
      htmlElement("span", "", `Spanne ${formatInteger(summary.spread)}`)
    );
    chart.append(summaryRow);
    const rows = htmlElement("div", "final-game-bar-rows");
    statistics.teams.slice().sort((left, right) => {
      const leftValue = id === "other" ? left.other : left.games[id];
      const rightValue = id === "other" ? right.other : right.games[id];
      return rightValue - leftValue || left.rank - right.rank || left.index - right.index;
    }).forEach((team) => {
      const value = id === "other" ? team.other : team.games[id];
      const row = htmlElement("div", "final-game-bar-row");
      const name = htmlElement("span", "final-game-bar-name", team.name);
      const track = htmlElement("div", "final-game-bar-track");
      const bar = htmlElement("i", `final-game-bar${value < 0 ? " negative" : " positive"}`);
      bar.style.width = `${Math.abs(value) / maximum * 50}%`;
      bar.style.background = teamColor(team.color, team.index).value;
      track.append(bar);
      row.append(name, track, htmlElement("strong", "final-game-bar-value", signed(value)));
      rows.append(row);
    });
    chart.append(rows);
    charts.append(chart);
  });
  section.append(charts);
  return section;
}
