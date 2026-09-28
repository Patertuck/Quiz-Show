import {
  calculateFinalStatistics, FINAL_GAME_LABELS, SCORE_HISTORY_COLORS, statisticTeamNames
} from "./score-history-chart.js";
import { teamColor } from "./team-colors.js";
import { formatInteger } from "./format-number.js";
import { hostFetch } from "./slot-api.js";

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
  const standingWidth = 1040;
  const standingHeight = Math.min(58, 245 / Math.max(1, lowerRanks.length));
  const standingGap = 10;
  const standingsHeight = lowerRanks.length * standingHeight + Math.max(0, lowerRanks.length - 1) * standingGap;
  const standingsTop = 135 + Math.max(0, (245 - standingsHeight) / 2);
  lowerRanks.forEach(([rank, members], index) => {
    const x = (WIDTH - standingWidth) / 2;
    const y = standingsTop + index * (standingHeight + standingGap);
    const fontSize = Math.min(25, standingHeight * 0.42);
    svg.append(svgNode("rect", { x, y, width: standingWidth, height: standingHeight, rx: 11, fill: "#080f35", "fill-opacity": 0.72, stroke: "#ffffff", "stroke-opacity": 0.3, "stroke-width": 2 }));
    svg.append(svgNode("text", { x: x + 18, y: y + standingHeight * 0.64, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": fontSize, "font-weight": 700 }, `Platz ${rank}: ${members.map(({ name }) => name).join(" & ")}`));
    svg.append(svgNode("text", { x: x + standingWidth - 18, y: y + standingHeight * 0.64, fill: "#fff45c", "font-family": "Arial, sans-serif", "font-size": fontSize, "font-weight": 800, "text-anchor": "end" }, `${formatInteger(members[0].score)} Punkte`));
  });

  const bottom = 1016;
  const podiumWidth = 1536;
  const placeWidth = 475;
  const placeGap = 30;
  const places = [
    { rank: 2, height: 408, colors: ["#ffffff", "#aeb9ca"] },
    { rank: 1, height: 552, colors: ["#fff6a5", "#e5ad26"] },
    { rank: 3, height: 288, colors: ["#e8b785", "#a95e31"] }
  ];
  const visiblePlaces = places.filter(({ rank }) => groups.has(rank));
  const visibleWidth = visiblePlaces.length * placeWidth + Math.max(0, visiblePlaces.length - 1) * placeGap;
  let placeX = (WIDTH - Math.min(podiumWidth, visibleWidth)) / 2;
  const defs = svg.querySelector("defs");
  visiblePlaces.forEach(({ rank, height, colors }) => {
    const members = groups.get(rank);
    const gradient = svgNode("linearGradient", { id: `rank-${rank}`, x1: 0, y1: 0, x2: 1, y2: 1 });
    gradient.append(svgNode("stop", { offset: "0%", "stop-color": colors[0] }), svgNode("stop", { offset: "100%", "stop-color": colors[1] }));
    defs.append(gradient);
    const y = bottom - height;
    svg.append(svgNode("rect", { x: placeX, y, width: placeWidth, height, rx: 18, fill: `url(#rank-${rank})` }));
    svg.append(svgNode("text", { x: placeX + placeWidth / 2, y: y + 112, fill: "#10194f", "font-family": "Arial, sans-serif", "font-size": 92, "font-weight": 900, "text-anchor": "middle" }, rank));
    appendWrappedText(svg, members.map(({ name }) => name).join(" & "), placeX + placeWidth / 2, y + 176, 27, {
      fill: "#10194f", "font-family": "Arial, sans-serif", "font-size": 32, "font-weight": 900, "text-anchor": "middle"
    });
    svg.append(svgNode("text", { x: placeX + placeWidth / 2, y: bottom - 34, fill: "#593800", "font-family": "Arial, sans-serif", "font-size": 27, "font-weight": 800, "text-anchor": "middle" }, `${formatInteger(members[0].score)} Punkte`));
    placeX += placeWidth + placeGap;
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
    svg.append(svgNode("text", { x: left - 24, y: y + 9, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 27, "font-weight": 700, "text-anchor": "end" }, formatInteger(value)));
  }
  const labelEvery = Math.max(1, Math.ceil(history.length / 14));
  history.forEach((entry, index) => {
    if (index && index !== history.length - 1 && index % labelEvery) return;
    const x = xAt(index);
    svg.append(svgNode("line", { x1: x, x2: x, y1: bottom, y2: bottom + 12, stroke: "#ffffff", "stroke-width": 3 }));
    svg.append(svgNode("text", { x, y: bottom + 46, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 25, "font-weight": 700, "text-anchor": "middle" }, index ? index : "Start"));
  });
  teams.forEach((team, teamIndex) => {
    const color = teamColor(team.color, teamIndex).value;
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
      svg.append(svgNode("circle", { cx: x + 11, cy: y, r: 11, fill: teamColor(team.color, index).value, stroke: "#ffffff", "stroke-width": 2 }));
      svg.append(svgNode("text", { x: x + 34, y: y + 9, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 27, "font-weight": 800 }, team.name));
      x += width + 38;
    });
  });
  return svg;
}

function createHighlightsSvg(teams, history, gameIds) {
  const svg = baseSvg("Quiz-Highlights");
  const statistics = calculateFinalStatistics(teams, history, gameIds);
  const biggest = statistics.awards.biggestGain;
  const cards = [
    ["Grösster Coup", biggest.value ? `+${formatInteger(biggest.value)}` : "–", statisticTeamNames(statistics, biggest.teamIndices) || "Kein Punktgewinn", biggest.games.filter(Boolean).map((game) => FINAL_GAME_LABELS[game]).join(" & ")],
    ["Stärkstes Comeback", statistics.awards.comeback.value ? formatInteger(statistics.awards.comeback.value) : "–", statisticTeamNames(statistics, statistics.awards.comeback.teamIndices) || "Kein Comeback", statistics.awards.comeback.value ? "Punkte Rückstand aufgeholt" : ""],
    ["Punktesammler", statistics.awards.collector.value ? formatInteger(statistics.awards.collector.value) : "–", statisticTeamNames(statistics, statistics.awards.collector.teamIndices) || "Keine Punkte gesammelt", "Positive Punkte insgesamt"],
    ["Meiste Spielsiege", statistics.awards.gameWins.value ? formatInteger(statistics.awards.gameWins.value) : "–", statisticTeamNames(statistics, statistics.awards.gameWins.teamIndices) || "Noch kein Spiel gewertet", statistics.awards.gameWins.value === 1 ? "Spielsieg" : "Spielsiege"],
    ["Führungswechsel", formatInteger(statistics.leadChanges), "Im gesamten Quiz", ""],
    ["Siegervorsprung", formatInteger(statistics.winnerMargin), statisticTeamNames(statistics, [...statistics.winnerIndices]), statistics.winnerMargin ? "Punkte" : "Geteilter erster Platz"]
  ];
  const cardWidth = 540;
  const cardHeight = 350;
  const gapX = 38;
  const gapY = 34;
  const startX = (WIDTH - cardWidth * 3 - gapX * 2) / 2;
  cards.forEach(([label, value, names, detail], index) => {
    const x = startX + (index % 3) * (cardWidth + gapX);
    const y = 155 + Math.floor(index / 3) * (cardHeight + gapY);
    svg.append(svgNode("rect", { x, y, width: cardWidth, height: cardHeight, rx: 24, fill: "#080f35", "fill-opacity": 0.76, stroke: "#ffffff", "stroke-opacity": 0.3, "stroke-width": 3 }));
    svg.append(svgNode("text", { x: x + cardWidth / 2, y: y + 62, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 31, "font-weight": 800, "text-anchor": "middle" }, label));
    svg.append(svgNode("text", { x: x + cardWidth / 2, y: y + 157, fill: "#fff45c", "font-family": "Arial, sans-serif", "font-size": 76, "font-weight": 900, "text-anchor": "middle" }, value));
    appendWrappedText(svg, names, x + cardWidth / 2, y + 218, 31, { fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": 28, "font-weight": 800, "text-anchor": "middle" });
    if (detail) svg.append(svgNode("text", { x: x + cardWidth / 2, y: y + 323, fill: "#bdc6ee", "font-family": "Arial, sans-serif", "font-size": 22, "font-weight": 700, "text-anchor": "middle" }, detail));
  });
  return svg;
}

function createGameBreakdownTableSvg(teams, history, gameIds) {
  const svg = baseSvg("Spielvergleich");
  const statistics = calculateFinalStatistics(teams, history, gameIds);
  const columns = [...statistics.gameIds.map((game) => ({ label: FINAL_GAME_LABELS[game], value: (team) => team.games[game] }))];
  if (statistics.hasOther) columns.push({ label: FINAL_GAME_LABELS.other, value: (team) => team.other });
  columns.push({ label: "Gesamt", value: (team) => team.netChange }, { label: "Endstand", value: (team) => team.finalScore });
  const left = 70;
  const top = 145;
  const tableWidth = WIDTH - left * 2;
  const teamWidth = 410;
  const columnWidth = (tableWidth - teamWidth) / columns.length;
  const orderedTeams = statistics.teams.slice().sort((leftTeam, rightTeam) => leftTeam.rank - rightTeam.rank || leftTeam.index - rightTeam.index);
  const rowHeight = Math.min(70, 830 / Math.max(1, orderedTeams.length + 1));
  svg.append(svgNode("rect", { x: left, y: top, width: tableWidth, height: rowHeight * (orderedTeams.length + 1), rx: 20, fill: "#080f35", "fill-opacity": 0.76, stroke: "#ffffff", "stroke-opacity": 0.3, "stroke-width": 3 }));
  svg.append(svgNode("text", { x: left + 22, y: top + rowHeight * 0.66, fill: "#fff45c", "font-family": "Arial, sans-serif", "font-size": 25, "font-weight": 900 }, "Team"));
  columns.forEach((column, index) => svg.append(svgNode("text", { x: left + teamWidth + (index + 0.5) * columnWidth, y: top + rowHeight * 0.66, fill: "#fff45c", "font-family": "Arial, sans-serif", "font-size": Math.min(25, columnWidth / 6), "font-weight": 900, "text-anchor": "middle" }, column.label)));
  orderedTeams.forEach((team, rowIndex) => {
    const y = top + (rowIndex + 1) * rowHeight;
    svg.append(svgNode("line", { x1: left, x2: left + tableWidth, y1: y, y2: y, stroke: "#ffffff", "stroke-opacity": 0.15, "stroke-width": 2 }));
    svg.append(svgNode("circle", { cx: left + 24, cy: y + rowHeight / 2, r: 10, fill: teamColor(team.color, team.index).value, stroke: "#ffffff", "stroke-width": 2 }));
    svg.append(svgNode("text", { x: left + 47, y: y + rowHeight * 0.64, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": Math.min(27, rowHeight * 0.42), "font-weight": 800 }, team.name.length > 26 ? `${team.name.slice(0, 25)}…` : team.name));
    columns.forEach((column, index) => {
      const value = column.value(team);
      const text = value > 0 && column.label !== "Endstand" ? `+${formatInteger(value)}` : formatInteger(value);
      svg.append(svgNode("text", { x: left + teamWidth + (index + 0.5) * columnWidth, y: y + rowHeight * 0.64, fill: ["Gesamt", "Endstand"].includes(column.label) ? "#fff45c" : "#ffffff", "font-family": "Arial, sans-serif", "font-size": Math.min(26, rowHeight * 0.4), "font-weight": ["Gesamt", "Endstand"].includes(column.label) ? 900 : 700, "text-anchor": "middle" }, text));
    });
  });
  return svg;
}

function createGameBreakdownSvg(teams, history, gameIds) {
  const svg = baseSvg("Spielvergleich");
  const statistics = calculateFinalStatistics(teams, history, gameIds);
  const games = statistics.gameIds.map((id) => ({ id, label: FINAL_GAME_LABELS[id] }));
  if (statistics.hasOther) games.push({ id: "other", label: FINAL_GAME_LABELS.other });
  const left = 70;
  const top = 145;
  const gap = 20;
  const panelWidth = (WIDTH - left * 2 - gap * (games.length - 1)) / games.length;
  const headerHeight = 98;
  const rowHeight = Math.min(60, 755 / Math.max(1, statistics.teams.length));
  const panelHeight = headerHeight + rowHeight * statistics.teams.length;
  const maximum = Math.max(1, ...statistics.teams.flatMap((team) => games.map(({ id }) => Math.abs(id === "other" ? team.other : team.games[id]))));
  games.forEach(({ id, label }, gameIndex) => {
    const x = left + gameIndex * (panelWidth + gap);
    svg.append(svgNode("rect", { x, y: top, width: panelWidth, height: panelHeight, rx: 20, fill: "#080f35", "fill-opacity": 0.76, stroke: "#ffffff", "stroke-opacity": 0.3, "stroke-width": 3 }));
    svg.append(svgNode("text", { x: x + panelWidth / 2, y: top + 34, fill: "#fff45c", "font-family": "Arial, sans-serif", "font-size": Math.min(27, panelWidth / 7), "font-weight": 900, "text-anchor": "middle" }, label));
    const summary = statistics.gameSummaries[id];
    svg.append(svgNode("text", { x: x + panelWidth / 2, y: top + 66, fill: "#bdc6ee", "font-family": "Arial, sans-serif", "font-size": Math.min(17, panelWidth / 13), "font-weight": 800, "text-anchor": "middle" }, `Netto ${summary.netPoints > 0 ? "+" : ""}${formatInteger(summary.netPoints)} · Anteil ${summary.percentage.toFixed(1)}%`));
    svg.append(svgNode("text", { x: x + panelWidth / 2, y: top + 88, fill: "#bdc6ee", "font-family": "Arial, sans-serif", "font-size": Math.min(17, panelWidth / 13), "font-weight": 800, "text-anchor": "middle" }, `Spanne ${formatInteger(summary.spread)}`));
    const orderedTeams = statistics.teams.slice().sort((leftTeam, rightTeam) => {
      const leftValue = id === "other" ? leftTeam.other : leftTeam.games[id];
      const rightValue = id === "other" ? rightTeam.other : rightTeam.games[id];
      return rightValue - leftValue || leftTeam.rank - rightTeam.rank || leftTeam.index - rightTeam.index;
    });
    orderedTeams.forEach((team, rowIndex) => {
      const value = id === "other" ? team.other : team.games[id];
      const y = top + headerHeight + rowIndex * rowHeight;
      const barLeft = x + 14;
      const barWidth = panelWidth - 28;
      const center = barLeft + barWidth / 2;
      const valueWidth = Math.abs(value) / maximum * (barWidth / 2);
      svg.append(svgNode("line", { x1: x, x2: x + panelWidth, y1: y, y2: y, stroke: "#ffffff", "stroke-opacity": 0.12, "stroke-width": 1 }));
      const shortName = team.name.length > 18 ? `${team.name.slice(0, 17)}…` : team.name;
      svg.append(svgNode("text", { x: barLeft, y: y + rowHeight * 0.38, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": Math.min(19, rowHeight * 0.31), "font-weight": 700 }, shortName));
      svg.append(svgNode("text", { x: x + panelWidth - 14, y: y + rowHeight * 0.38, fill: "#ffffff", "font-family": "Arial, sans-serif", "font-size": Math.min(19, rowHeight * 0.31), "font-weight": 800, "text-anchor": "end" }, value > 0 ? `+${formatInteger(value)}` : formatInteger(value)));
      svg.append(svgNode("line", { x1: center, x2: center, y1: y + rowHeight * 0.5, y2: y + rowHeight * 0.88, stroke: "#ffffff", "stroke-opacity": 0.55, "stroke-width": 2 }));
      if (valueWidth > 0) svg.append(svgNode("rect", { x: value < 0 ? center - valueWidth : center, y: y + rowHeight * 0.58, width: valueWidth, height: rowHeight * 0.22, rx: rowHeight * 0.11, fill: teamColor(team.color, team.index).value, "fill-opacity": value < 0 ? 0.72 : 1 }));
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

export async function exportFinalResults(teams, scoreHistory, gameIds) {
  const [podiumPng, scoreHistoryPng, highlightsPng, gameBreakdownPng] = await Promise.all([
    svgToPngBase64(createPodiumSvg(teams)),
    svgToPngBase64(createHistorySvg(teams, scoreHistory)),
    svgToPngBase64(createHighlightsSvg(teams, scoreHistory, gameIds)),
    svgToPngBase64(createGameBreakdownSvg(teams, scoreHistory, gameIds))
  ]);
  const response = await hostFetch("/api/final-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ podiumPng, scoreHistoryPng, highlightsPng, gameBreakdownPng, gameIds })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
