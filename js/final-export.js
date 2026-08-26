import { SCORE_HISTORY_COLORS } from "./score-history-chart.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 1920;
const HEIGHT = 1080;
const GAME_LABELS = {
  jeopardy: "Jeopardy",
  ordering: "Order Up",
  listing: "List It",
  sync: "Sync Up",
  legacy: "Frühere Punkte"
};

function svgNode(tag, attributes = {}, text = "") {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  if (text !== "") node.textContent = text;
  return node;
}

function baseSvg(title) {
  const svg = svgNode("svg", { xmlns: SVG_NS, width: WIDTH, height: HEIGHT, viewBox: `0 0 ${WIDTH} ${HEIGHT}` });
  const defs = svgNode("defs");
  const background = svgNode("radialGradient", { id: "background", cx: "50%", cy: "12%", r: "85%" });
  background.append(
    svgNode("stop", { offset: "0%", "stop-color": "#4258d2" }),
    svgNode("stop", { offset: "48%", "stop-color": "#17206a" }),
    svgNode("stop", { offset: "100%", "stop-color": "#080d38" })
  );
  defs.append(background);
  svg.append(defs, svgNode("rect", { width: WIDTH, height: HEIGHT, fill: "url(#background)" }));
  svg.append(svgNode("text", {
    x: WIDTH / 2, y: 92, fill: "#fff45c", "font-family": "Arial, sans-serif",
    "font-size": 66, "font-weight": 900, "text-anchor": "middle"
  }, title));
  return svg;
}

function rankedTeams(teams) {
  const sorted = teams.map((team, originalIndex) => ({ ...team, originalIndex }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
  let previousScore;
  let previousRank = 0;
  return sorted.map((team, index) => {
    const rank = index === 0 || team.score < previousScore ? index + 1 : previousRank;
    previousScore = team.score;
    previousRank = rank;
    return { ...team, rank };
  });
}

function appendWrappedText(parent, text, x, y, maxCharacters, attributes = {}) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxCharacters) {
      lines.push(line);
      line = word;
    } else line = candidate;
  });
  if (line) lines.push(line);
  const element = svgNode("text", { x, y, ...attributes });
  lines.slice(0, 3).forEach((value, index) => {
    const tspan = svgNode("tspan", { x, dy: index ? "1.1em" : 0 }, value);
    element.append(tspan);
  });
  parent.append(element);
}

function createPodiumSvg(teams) {
  const svg = baseSvg("Endstand");
  const ranked = rankedTeams(teams);
  const groups = new Map();
  ranked.forEach((team) => {
    if (!groups.has(team.rank)) groups.set(team.rank, []);
    groups.get(team.rank).push(team);
  });
  const lowerRanks = [...groups.entries()].filter(([rank]) => rank > 3).sort(([a], [b]) => a - b);
  const columns = Math.min(3, Math.max(1, lowerRanks.length));
  const rows = Math.ceil(lowerRanks.length / columns);
  const cardWidth = columns === 1 ? 900 : columns === 2 ? 760 : 560;
  const cardHeight = Math.min(64, 230 / Math.max(1, rows));
  lowerRanks.forEach(([rank, members], index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowColumns = Math.min(columns, lowerRanks.length - row * columns);
    const totalWidth = rowColumns * cardWidth + (rowColumns - 1) * 24;
    const x = (WIDTH - totalWidth) / 2 + column * (cardWidth + 24);
    const y = 130 + row * (cardHeight + 12);
    svg.append(svgNode("rect", { x, y, width: cardWidth, height: cardHeight, rx: 16, fill: "#080f35", "fill-opacity": 0.78, stroke: "#ffffff", "stroke-opacity": 0.28, "stroke-width": 2 }));
    svg.append(svgNode("text", { x: x + 22, y: y + cardHeight * 0.64, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": Math.min(28, cardHeight * 0.43), "font-weight": 700 }, `Platz ${rank}: ${members.map(({ name }) => name).join(" & ")}`));
    svg.append(svgNode("text", { x: x + cardWidth - 22, y: y + cardHeight * 0.64, fill: "#fff45c", "font-family": "Arial, sans-serif", "font-size": Math.min(27, cardHeight * 0.42), "font-weight": 800, "text-anchor": "end" }, `${members[0].score.toLocaleString("de-CH")} Punkte`));
  });

  const podiumTop = lowerRanks.length ? 420 : 230;
  const bottom = 1030;
  const places = [
    { rank: 2, x: 250, width: 460, height: 400, colors: ["#ffffff", "#aeb9ca"] },
    { rank: 1, x: 730, width: 460, height: 550, colors: ["#fff6a5", "#e5ad26"] },
    { rank: 3, x: 1210, width: 460, height: 320, colors: ["#e8b785", "#a95e31"] }
  ];
  const defs = svg.querySelector("defs");
  places.forEach(({ rank, x, width, height, colors }) => {
    const members = groups.get(rank);
    if (!members) return;
    const adjustedHeight = Math.min(height, bottom - podiumTop);
    const gradient = svgNode("linearGradient", { id: `rank-${rank}`, x1: 0, y1: 0, x2: 1, y2: 1 });
    gradient.append(svgNode("stop", { offset: "0%", "stop-color": colors[0] }), svgNode("stop", { offset: "100%", "stop-color": colors[1] }));
    defs.append(gradient);
    const y = bottom - adjustedHeight;
    svg.append(svgNode("rect", { x, y, width, height: adjustedHeight, rx: 24, fill: `url(#rank-${rank})` }));
    svg.append(svgNode("text", { x: x + width / 2, y: y + 100, fill: "#10194f", "font-family": "Arial, sans-serif", "font-size": 92, "font-weight": 900, "text-anchor": "middle" }, rank));
    appendWrappedText(svg, members.map(({ name }) => name).join(" & "), x + width / 2, y + 175, 24, {
      fill: "#10194f", "font-family": "Arial, sans-serif", "font-size": 38, "font-weight": 900, "text-anchor": "middle"
    });
    svg.append(svgNode("text", { x: x + width / 2, y: bottom - 38, fill: "#593800", "font-family": "Arial, sans-serif", "font-size": 31, "font-weight": 800, "text-anchor": "middle" }, `${members[0].score.toLocaleString("de-CH")} Punkte`));
  });
  return svg;
}

function niceStep(range, targetTicks = 5) {
  if (!range) return 1;
  const rough = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

function createHistorySvg(teams, history) {
  const svg = baseSvg("Punkteverlauf");
  const left = 145;
  const right = 1840;
  const top = 205;
  const bottom = 900;
  const scores = history.flatMap(({ scores: values }) => values);
  const rawMin = Math.min(0, ...scores);
  const rawMax = Math.max(0, ...scores);
  const tickStep = niceStep(Math.max(1, rawMax - rawMin));
  let yMin = Math.floor(rawMin / tickStep) * tickStep;
  let yMax = Math.ceil(rawMax / tickStep) * tickStep;
  if (yMin === yMax) yMax += tickStep;
  const xAt = (index) => history.length === 1 ? left : left + index / (history.length - 1) * (right - left);
  const yAt = (score) => bottom - (score - yMin) / (yMax - yMin) * (bottom - top);

  const runs = [];
  history.slice(1).forEach((entry, offset) => {
    const index = offset + 1;
    const game = entry.game || "legacy";
    if (runs.at(-1)?.game === game) runs.at(-1).end = index;
    else runs.push({ game, start: index, end: index });
  });
  runs.forEach((run, index) => {
    if (index) {
      const x = (xAt(run.start - 1) + xAt(run.start)) / 2;
      svg.append(svgNode("line", { x1: x, x2: x, y1: top - 30, y2: bottom, stroke: "#fff45c", "stroke-opacity": 0.7, "stroke-width": 3, "stroke-dasharray": "12 10" }));
    }
    svg.append(svgNode("text", { x: (xAt(run.start) + xAt(run.end)) / 2, y: top - 48, fill: "#fff45c", "font-family": "Arial, sans-serif", "font-size": 28, "font-weight": 900, "text-anchor": "middle" }, GAME_LABELS[run.game] || run.game));
  });
  for (let value = yMin; value <= yMax + tickStep / 2; value += tickStep) {
    const y = yAt(value);
    svg.append(svgNode("line", { x1: left, x2: right, y1: y, y2: y, stroke: "#ffffff", "stroke-opacity": value === 0 ? 0.45 : 0.16, "stroke-width": value === 0 ? 4 : 2 }));
    svg.append(svgNode("text", { x: left - 24, y: y + 9, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 27, "font-weight": 700, "text-anchor": "end" }, value.toLocaleString("de-CH")));
  }
  const labelEvery = Math.max(1, Math.ceil(history.length / 14));
  history.forEach((entry, index) => {
    if (index && index !== history.length - 1 && index % labelEvery) return;
    const x = xAt(index);
    svg.append(svgNode("line", { x1: x, x2: x, y1: bottom, y2: bottom + 12, stroke: "#ffffff", "stroke-width": 3 }));
    svg.append(svgNode("text", { x, y: bottom + 46, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 25, "font-weight": 700, "text-anchor": "middle" }, index ? index : "Start"));
  });
  teams.forEach((team, teamIndex) => {
    const color = SCORE_HISTORY_COLORS[teamIndex % SCORE_HISTORY_COLORS.length];
    const points = history.map((entry, index) => `${xAt(index)},${yAt(entry.scores[teamIndex])}`).join(" ");
    svg.append(svgNode("polyline", { points, fill: "none", stroke: color, "stroke-width": 7, "stroke-linejoin": "round" }));
    history.forEach((entry, index) => svg.append(svgNode("circle", { cx: xAt(index), cy: yAt(entry.scores[teamIndex]), r: 7, fill: color, stroke: "#10194f", "stroke-width": 3 })));
  });
  svg.append(svgNode("line", { x1: left, x2: left, y1: top, y2: bottom, stroke: "#ffffff", "stroke-opacity": 0.75, "stroke-width": 4 }));
  svg.append(svgNode("line", { x1: left, x2: right, y1: bottom, y2: bottom, stroke: "#ffffff", "stroke-opacity": 0.75, "stroke-width": 4 }));
  const measurement = document.createElement("canvas").getContext("2d");
  measurement.font = "800 27px Arial";
  const legendItems = teams.map((team, index) => ({
    team,
    index,
    width: 36 + Math.ceil(measurement.measureText(team.name).width)
  }));
  const legendRows = [];
  legendItems.forEach((item) => {
    const row = legendRows.at(-1);
    const occupied = row?.reduce((total, entry) => total + entry.width, 0) || 0;
    const gaps = row?.length ? row.length * 38 : 0;
    if (!row || occupied + gaps + item.width > 1650) legendRows.push([item]);
    else row.push(item);
  });
  const rowHeight = 42;
  const firstLegendY = 1005 - ((legendRows.length - 1) * rowHeight) / 2;
  legendRows.forEach((row, rowIndex) => {
    const rowWidth = row.reduce((total, item) => total + item.width, 0) + Math.max(0, row.length - 1) * 38;
    let x = (WIDTH - rowWidth) / 2;
    const y = firstLegendY + rowIndex * rowHeight;
    row.forEach(({ team, index, width }) => {
      svg.append(svgNode("circle", { cx: x + 11, cy: y, r: 11, fill: SCORE_HISTORY_COLORS[index % SCORE_HISTORY_COLORS.length], stroke: "#ffffff", "stroke-width": 2 }));
      svg.append(svgNode("text", { x: x + 34, y: y + 9, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 27, "font-weight": 800 }, team.name));
      x += width + 38;
    });
  });
  return svg;
}

async function svgToPngBase64(svg) {
  const source = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.getContext("2d").drawImage(image, 0, 0, WIDTH, HEIGHT);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNG konnte nicht erstellt werden.")), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportFinalResults(teams, scoreHistory) {
  const [podiumPng, scoreHistoryPng] = await Promise.all([
    svgToPngBase64(createPodiumSvg(teams)),
    svgToPngBase64(createHistorySvg(teams, scoreHistory))
  ]);
  const response = await fetch("/api/final-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ podiumPng, scoreHistoryPng })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
