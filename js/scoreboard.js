import { state, saveState } from "./store.js";

let container;

export function initializeScoreboard(element) {
  container = element;
}

export function renderScoreboard() {
  if (!container) return;
  container.replaceChildren();
  state.teams.forEach((team, index) => {
    const card = document.createElement("section");
    card.className = "team";
    card.dataset.teamIndex = index;

    const name = document.createElement("div");
    name.className = "team-name";
    name.textContent = team.name;
    name.title = team.name;

    const subtract = scoreButton("subtract", index, () => changeScore(index, -state.activeValue));
    const score = document.createElement("output");
    score.className = "score";
    score.id = `team-score-${index}`;
    score.textContent = team.score.toLocaleString();
    score.setAttribute("aria-label", `Punktestand von ${team.name}`);
    const add = scoreButton("add", index, () => changeScore(index, state.activeValue));

    card.append(name, subtract, score, add);
    container.append(card);
  });
  updateStandings();
  updateScoreControls();
}

function scoreButton(action, teamIndex, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `score-button ${action}`;
  button.dataset.teamIndex = teamIndex;
  button.dataset.action = action;
  button.addEventListener("click", handler);
  return button;
}

function changeScore(teamIndex, amount) {
  if (!state.activeValue) return;
  const team = state.teams[teamIndex];
  team.score += amount;
  container.querySelector(`#team-score-${teamIndex}`).textContent = team.score.toLocaleString();
  updateStandings();
  saveState().catch(() => undefined);
  window.dispatchEvent(new CustomEvent("quiz-score-changed", { detail: { teamIndex, amount } }));
}

export function updateStandings() {
  if (!container) return;
  container.querySelectorAll(".team").forEach((card) => {
    const team = state.teams[Number(card.dataset.teamIndex)];
    const rank = 1 + state.teams.filter((candidate) => candidate.score > team.score).length;
    card.classList.toggle("rank-first", rank === 1);
    card.classList.toggle("rank-second", rank === 2);
    card.classList.toggle("rank-third", rank === 3);
  });
}

export function updateScoreControls() {
  if (!container) return;
  const active = state.activeValue > 0;
  container.querySelectorAll(".score-button").forEach((button) => {
    const team = state.teams[Number(button.dataset.teamIndex)];
    const isAdd = button.dataset.action === "add";
    const sign = isAdd ? "+" : "−";
    button.disabled = !active;
    button.textContent = active ? `${sign}${state.activeValue.toLocaleString()}` : sign;
    button.setAttribute("aria-label", active
      ? `${state.activeValue} Punkte bei ${team.name} ${isAdd ? "hinzufügen" : "abziehen"}`
      : `Keine aktive Frage; Punktevergabe für ${team.name} nicht verfügbar`);
  });
}

export function setScoreboard(mode) {
  if (!container) return;
  if (mode === "hidden") {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.classList.toggle("standings-only", mode === "standings");
  updateScoreControls();
}
