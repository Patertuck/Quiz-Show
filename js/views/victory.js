import { state, saveState } from "../store.js";
import { publishScoreHistory, publishVictory } from "../presentation-host.js";
import { createScoreHistoryChart } from "../score-history-chart.js";

export async function mount(root) {
  await saveState().catch((error) => console.error("Could not save before final standings:", error));
  const view = root.querySelector("#victory-view");
  const reveals = root.querySelector("#standing-reveals");
  const podium = root.querySelector("#podium");
  const confetti = root.querySelector("#confetti");
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
    score.textContent = ` ${teams[0].score.toLocaleString("de-CH")} Punkte`;
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
    score.textContent = `${teams[0].score.toLocaleString("de-CH")} Punkte`;
    place.append(number, names, score);
    podium.append(place);
    steps.push(place);
    presentationSteps.push({
      kind: "podium", rank, names: teams.map((team) => team.name).join(" & "), score: teams[0].score
    });
  });

  let stepIndex = 0;
  let graphShown = false;
  function createConfetti() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    confetti.replaceChildren(...Array.from({ length: 100 }, (_, index) => {
      const piece = document.createElement("i");
      const duration = 2400 + Math.random() * 1800;
      piece.className = "confetti-piece";
      piece.style.setProperty("--confetti-left", `${Math.random() * 100}%`);
      piece.style.setProperty("--confetti-size", `${6 + Math.random() * 8}px`);
      piece.style.setProperty("--confetti-hue", String((index * 43) % 360));
      piece.style.setProperty("--confetti-drift", `${-18 + Math.random() * 36}vw`);
      piece.style.setProperty("--confetti-delay", `${Math.random() * duration}ms`);
      piece.style.setProperty("--confetti-duration", `${duration}ms`);
      return piece;
    }));
  }
  function advance(event) {
    if (event.target.closest(".back-to-hub")) return;
    const step = steps[stepIndex];
    if (!step) {
      if (graphShown || stepIndex < steps.length) return;
      graphShown = true;
      view.classList.add("score-history-mode");
      reveals.hidden = true;
      podium.hidden = true;
      confetti.replaceChildren();
      view.querySelector(":scope > h1").hidden = true;
      view.append(createScoreHistoryChart(state.teams, state.scoreHistory));
      publishScoreHistory(state.scoreHistory).catch(() => undefined);
      return;
    }
    step.classList.add("is-revealed");
    stepIndex += 1;
    publishVictory(presentationSteps, stepIndex).catch(() => undefined);
    if (step.dataset.rank === "1") createConfetti();
  }
  publishVictory(presentationSteps, 0).catch(() => undefined);
  view.addEventListener("click", advance);
  return () => view.removeEventListener("click", advance);
}
