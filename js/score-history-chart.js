const SVG_NS = "http://www.w3.org/2000/svg";

export const SCORE_HISTORY_COLORS = [
  "#ffdd3c", "#4de3ff", "#ff6384", "#70e36b", "#bd7cff", "#ff9f43",
  "#45a3ff", "#f368e0", "#a3e635", "#ff6b35", "#55efc4", "#c7d2fe"
];

const SCORE_HISTORY_GAME_LABELS = {
  jeopardy: "Jeopardy",
  ordering: "Order Up",
  listing: "List It",
  sync: "Sync Up",
  legacy: "Frühere Punkte"
};

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
    label.textContent = value.toLocaleString("de-CH");
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
    const color = SCORE_HISTORY_COLORS[teamIndex % SCORE_HISTORY_COLORS.length];
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
      pointTitle.textContent = `${team.name}: ${entry.scores[teamIndex].toLocaleString("de-CH")} Punkte · ${gameLabel}`;
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
    swatch.style.background = SCORE_HISTORY_COLORS[index % SCORE_HISTORY_COLORS.length];
    item.append(swatch, document.createTextNode(team.name));
    legend.append(item);
  });
  section.append(heading, svg, legend);
  return section;
}
