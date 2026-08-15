const SVG_NS = "http://www.w3.org/2000/svg";

export const SCORE_HISTORY_COLORS = [
  "#ffdd3c", "#4de3ff", "#ff6384", "#70e36b", "#bd7cff", "#ff9f43",
  "#45a3ff", "#f368e0", "#a3e635", "#ff6b35", "#55efc4", "#c7d2fe"
];

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
  description.textContent = "Jede Linie zeigt den Punktestand eines Teams nach jeder Punkteänderung.";
  svg.append(title, description);

  const left = 105;
  const right = 1160;
  const top = 35;
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
    const points = history.map((entry, index) => `${xAt(index)},${yAt(entry.scores[teamIndex])}`);
    const line = svgElement("polyline", { class: "score-history-line", points: points.join(" "), stroke: color });
    svg.append(line);
    if (history.length <= 80) {
      history.forEach((entry, index) => {
        const point = svgElement("circle", {
          class: "score-history-point", cx: xAt(index), cy: yAt(entry.scores[teamIndex]), r: 5, fill: color
        });
        const pointTitle = svgElement("title");
        pointTitle.textContent = `${team.name}: ${entry.scores[teamIndex].toLocaleString("de-CH")} Punkte`;
        point.append(pointTitle);
        svg.append(point);
      });
    }
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
