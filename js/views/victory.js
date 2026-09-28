import { state, saveState } from "../store.js";
import { formatInteger } from "../format-number.js";
import {
  publishFinalHighlights, publishGameBreakdown, publishScoreHistory, publishVictory
} from "../presentation-host.js";
import { createGameBreakdownView, createHighlightsView, createScoreHistoryChart } from "../score-history-chart.js";
import { exportFinalResults } from "../final-export.js";
import { configuredGameIds } from "../game-catalog.js";

export async function mount(root) {
  await saveState().catch((error) => console.error("Could not save before final standings:", error));
  const view = root.querySelector("#victory-view");
  const reveals = root.querySelector("#standing-reveals");
  const podium = root.querySelector("#podium");
  const exportStatus = root.querySelector("#final-export-status");
  const exportStatusText = exportStatus.querySelector("span");
  const exportRetry = exportStatus.querySelector("button");
  const navigation = root.querySelector("#final-navigation");
  const previousButton = navigation.querySelector('[data-direction="previous"]');
  const nextButton = navigation.querySelector('[data-direction="next"]');
  const pageIndicator = navigation.querySelector("span");
  const gameIds = configuredGameIds(state.config);
  const sorted = [...state.teams]
    .map((team, originalIndex) => ({ ...team, originalIndex }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
  let previousScore;
  let previousRank = 0;
  const ranked = sorted.map((team, index) => {
    const rank = index === 0 || team.score < previousScore ? index + 1 : previousRank;
    previousScore = team.score;
    previousRank = rank;
    return { ...team, rank };
  });
  const byRank = new Map();
  ranked.forEach((team) => {
    if (!byRank.has(team.rank)) byRank.set(team.rank, []);
    byRank.get(team.rank).push(team);
  });
  const steps = [];
  const presentationSteps = [];

  [...byRank.entries()].filter(([rank]) => rank > 3).sort(([a], [b]) => b - a).forEach(([rank, teams]) => {
    const row = document.createElement("div");
    row.className = "standing-reveal";
    const names = teams.map((team) => team.name).join(" & ");
    row.innerHTML = `<span>Platz ${rank}: </span>`;
    row.firstElementChild.append(document.createTextNode(names));
    const score = document.createElement("span");
    score.className = "standing-score";
    score.textContent = ` ${formatInteger(teams[0].score)} Punkte`;
    row.append(score);
    reveals.append(row);
    steps.push(row);
    presentationSteps.push({ kind: "standing", rank, names, score: teams[0].score });
  });

  [3, 2, 1].forEach((rank) => {
    const teams = byRank.get(rank);
    if (!teams) return;
    const place = document.createElement("section");
    place.className = `podium-place rank-${rank}`;
    place.dataset.rank = rank;
    const number = document.createElement("div");
    number.className = "podium-rank";
    number.textContent = rank;
    const names = document.createElement("div");
    names.className = "podium-names";
    names.textContent = teams.map((team) => team.name).join(" & ");
    const score = document.createElement("div");
    score.className = "podium-score";
    score.textContent = `${formatInteger(teams[0].score)} Punkte`;
    place.append(number, names, score);
    podium.append(place);
    steps.push(place);
    presentationSteps.push({
      kind: "podium", rank, names: teams.map((team) => team.name).join(" & "), score: teams[0].score
    });
  });

  const slideNodes = [
    null,
    createScoreHistoryChart(state.teams, state.scoreHistory),
    createHighlightsView(state.teams, state.scoreHistory, gameIds),
    createGameBreakdownView(state.teams, state.scoreHistory, gameIds)
  ];
  slideNodes.slice(1).forEach((node) => { node.hidden = true; view.append(node); });
  let stepIndex = 0;
  let slideIndex = 0;
  let exportRunning = false;
  let statusTimer;
  async function runFinalExport() {
    if (exportRunning) return;
    exportRunning = true;
    clearTimeout(statusTimer);
    exportStatus.hidden = false;
    exportRetry.hidden = true;
    exportStatusText.textContent = "Endspiel-Export wird gespeichert …";
    try {
      const result = await exportFinalResults(state.teams, state.scoreHistory, gameIds);
      exportStatusText.textContent = `${result.created ? "Export gespeichert" : "Export bereits vorhanden"}: ${result.directory}`;
      statusTimer = setTimeout(() => { exportStatus.hidden = true; }, 9000);
    } catch (error) {
      console.error("Could not export final results:", error);
      exportStatusText.textContent = `Export fehlgeschlagen: ${error.message}`;
      exportRetry.hidden = false;
    } finally {
      exportRunning = false;
    }
  }
  exportRetry.addEventListener("click", (event) => {
    event.stopPropagation();
    runFinalExport();
  });
  function publishSlide() {
    if (slideIndex === 0) return publishVictory(presentationSteps, stepIndex);
    if (slideIndex === 1) return publishScoreHistory(state.scoreHistory);
    if (slideIndex === 2) return publishFinalHighlights(state.scoreHistory, gameIds);
    return publishGameBreakdown(state.scoreHistory, gameIds);
  }
  function renderSlide() {
    const onPodium = slideIndex === 0;
    navigation.hidden = stepIndex < steps.length;
    view.classList.toggle("final-slide-mode", !onPodium);
    reveals.hidden = !onPodium;
    podium.hidden = !onPodium;
    view.querySelector(":scope > h1").hidden = !onPodium;
    slideNodes.slice(1).forEach((node, index) => { node.hidden = slideIndex !== index + 1; });
    pageIndicator.textContent = `${slideIndex + 1} / ${slideNodes.length}`;
    previousButton.disabled = slideIndex === 0;
    nextButton.disabled = slideIndex === slideNodes.length - 1;
  }
  function next() {
    if (slideIndex === 0 && stepIndex < steps.length) {
      const step = steps[stepIndex];
      step.classList.add("is-revealed");
      stepIndex += 1;
      if (step.dataset.rank === "1") runFinalExport();
    } else if (slideIndex < slideNodes.length - 1) slideIndex += 1;
    renderSlide();
    publishSlide().catch(() => undefined);
  }
  function previous() {
    if (slideIndex > 0) slideIndex -= 1;
    renderSlide();
    publishSlide().catch(() => undefined);
  }
  function advance(event) {
    if (event.target.closest(".back-to-hub, #final-export-status, #final-navigation")) return;
    next();
  }
  function handleKeydown(event) {
    if (event.target.closest?.("input, textarea, select")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); next(); }
    if (event.key === "ArrowLeft" && stepIndex >= steps.length) { event.preventDefault(); previous(); }
  }
  publishVictory(presentationSteps, 0).catch(() => undefined);
  renderSlide();
  view.addEventListener("click", advance);
  previousButton.addEventListener("click", previous);
  nextButton.addEventListener("click", next);
  document.addEventListener("keydown", handleKeydown);
  return () => {
    clearTimeout(statusTimer);
    view.removeEventListener("click", advance);
    previousButton.removeEventListener("click", previous);
    nextButton.removeEventListener("click", next);
    document.removeEventListener("keydown", handleKeydown);
  };
}
