import { publishOrdering } from "../presentation-host.js";
import { state, applyAward, saveState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";

let root;
let content;
let statusLine;
let orderingState;
let events;
let ticker;
let selectedQuestion = null;
let selectedPreviewItems = [];

async function request(action, extra = {}) {
  const response = await fetch("/api/ordering/control", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setStatus(message = "") {
  statusLine.textContent = message;
}

function button(label, className, onClick, disabled = false) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.disabled = disabled;
  element.addEventListener("click", async () => {
    element.disabled = true;
    try { await onClick(); }
    catch (error) { console.error(error); setStatus(error.message); element.disabled = disabled; }
  });
  return element;
}

function itemText(itemId, round) {
  return round.shuffledItems.find((item) => item.id === itemId)?.text || itemId;
}

function remaining(round) {
  return Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000));
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function questionSelection(highlightedQuestionId = selectedQuestion?.id || null) {
  return {
    questions: state.config.ordering.questions.map(({ id, title }) => ({
      id,
      title,
      completed: orderingState.completedQuestionIds.includes(id)
    })),
    highlightedQuestionId,
    selectedQuestion: selectedQuestion ? {
      id: selectedQuestion.id,
      title: selectedQuestion.title,
      prompt: selectedQuestion.prompt,
      items: selectedPreviewItems
    } : null
  };
}

function publishQuestionSelection(highlightedQuestionId) {
  publishOrdering(questionSelection(highlightedQuestionId)).catch(() => undefined);
}

function renderOverview() {
  setStatus("Wählt eine Frage aus.");
  const grid = document.createElement("div");
  grid.className = "ordering-question-grid";
  state.config.ordering.questions.forEach((question) => {
    const complete = orderingState.completedQuestionIds.includes(question.id);
    const card = button(question.title, "ordering-question-card", async () => {
      selectedQuestion = question;
      selectedPreviewItems = shuffled(question.items);
      renderPreview();
      publishQuestionSelection(question.id);
    }, complete);
    if (complete) card.title = "Bereits abgeschlossen";
    if (!complete) {
      card.addEventListener("pointerenter", () => publishQuestionSelection(question.id));
      card.addEventListener("pointerleave", () => publishQuestionSelection(null));
      card.addEventListener("focus", () => publishQuestionSelection(question.id));
      card.addEventListener("blur", () => publishQuestionSelection(null));
    }
    grid.append(card);
  });
  content.replaceChildren(grid);
}

function renderPreview() {
  const question = selectedQuestion;
  setStatus("Der Timer startet, sobald ihr auf «Starten» drückt.");
  const preview = document.createElement("section"); preview.className = "ordering-preview";
  const title = document.createElement("h2"); title.textContent = question.title;
  const prompt = document.createElement("p"); prompt.textContent = question.prompt;
  const details = document.createElement("p"); details.textContent = `${question.items.length} Elemente · ${question.timeLimitSeconds} Sekunden · ${state.config.ordering.pointsPerCorrect} Punkte pro richtiger Position`;
  const list = document.createElement("ol");
  question.items.forEach((text) => { const item = document.createElement("li"); item.textContent = text; list.append(item); });
  preview.append(title, prompt, details, list);
  const actions = document.createElement("div"); actions.className = "ordering-actions";
  actions.append(
    button("Starten", "primary-button", () => request("start", { question: { ...question, pointsPerCorrect: state.config.ordering.pointsPerCorrect } })),
    button("Zurück", "secondary-button", async () => {
      selectedQuestion = null;
      selectedPreviewItems = [];
      renderOverview();
      publishQuestionSelection(null);
    })
  );
  content.replaceChildren(preview, actions);
}

function renderActive(round) {
  const timer = document.createElement("div");
  timer.className = "ordering-timer";
  timer.dataset.deadline = round.deadlineAt;
  timer.textContent = remaining(round);
  setStatus(`${round.prompt} · ${orderingState.connectedTeamCount} ${orderingState.connectedTeamCount === 1 ? "Team verbunden" : "Teams verbunden"}`);
  const columns = document.createElement("div");
  columns.className = "ordering-live-columns";
  orderingState.teams.forEach((name, teamIndex) => {
    const column = document.createElement("section");
    column.className = "ordering-live-team";
    const heading = document.createElement("h2");
    heading.textContent = name;
    const list = document.createElement("ol");
    round.teamOrders[teamIndex].forEach((id) => {
      const item = document.createElement("li"); item.textContent = itemText(id, round); list.append(item);
    });
    column.append(heading, list);
    columns.append(column);
  });
  const answer = document.createElement("details");
  answer.className = "ordering-private-answer";
  answer.innerHTML = `<summary>Lösung für die Spielleitung</summary><ol>${round.correctItems.map((item) => `<li></li>`).join("")}</ol>`;
  answer.querySelectorAll("li").forEach((li, index) => { li.textContent = round.correctItems[index].text; });
  const actions = document.createElement("div"); actions.className = "ordering-actions";
  actions.append(
    button("Antworten sperren", "primary-button", () => request("lock")),
    button("Runde abbrechen", "danger-button", confirmCancel)
  );
  content.replaceChildren(timer, columns, answer, actions);
}

function teamColumn(round, teamIndex) {
  const column = document.createElement("section");
  column.className = "ordering-result-column";
  column.style.setProperty("--ordering-count", round.correctItems.length);
  const heading = document.createElement("h2");
  heading.innerHTML = `<span></span><strong></strong>`;
  heading.querySelector("span").textContent = orderingState.teams[teamIndex];
  heading.querySelector("strong").textContent = `+${round.roundPoints[teamIndex]}`;
  column.append(heading);
  const correct = round.correctItems.map((item) => item.id);
  round.teamOrders[teamIndex].forEach((id, slot) => {
    const cell = document.createElement("div");
    cell.className = "ordering-result-cell";
    if (round.revealed.includes(slot)) cell.classList.add(id === correct[slot] ? "correct" : "wrong");
    cell.textContent = itemText(id, round);
    column.append(cell);
  });
  return column;
}

function renderResults(round) {
  const allRevealed = round.revealed.length === round.correctItems.length;
  setStatus(round.phase === "distributed" ? "Punkte wurden verteilt." : "Klickt auf die Antwortfelder, um sie in beliebiger Reihenfolge aufzudecken.");
  const board = document.createElement("div"); board.className = "ordering-results";
  const split = Math.ceil(orderingState.teams.length / 2);
  const left = document.createElement("div"); left.className = "ordering-result-side";
  const right = document.createElement("div"); right.className = "ordering-result-side";
  orderingState.teams.forEach((_, index) => (index < split ? left : right).append(teamColumn(round, index)));
  const solution = document.createElement("section"); solution.className = "ordering-result-column ordering-solution";
  solution.style.setProperty("--ordering-count", round.correctItems.length);
  const title = document.createElement("h2"); title.textContent = "Richtige Reihenfolge"; solution.append(title);
  round.correctItems.forEach((item, slot) => {
    const revealed = round.revealed.includes(slot);
    solution.append(button(revealed ? item.text : `Position ${slot + 1} aufdecken`, `ordering-result-cell solution-cell${revealed ? " revealed" : ""}`,
      () => request("reveal", { slot }), revealed || round.phase === "distributed"));
  });
  board.append(left, solution, right);
  const actions = document.createElement("div"); actions.className = "ordering-actions";
  if (round.phase === "distributed") {
    actions.append(button("Zurück zu den Fragen", "primary-button", () => request("close")));
  } else {
    actions.append(
      button("Punkte verteilen", "primary-button", distribute, !allRevealed),
      button("Runde abbrechen", "danger-button", confirmCancel, round.revealed.length > 0)
    );
  }
  content.replaceChildren(board, actions);
}

async function distribute() {
  const award = await request("awards");
  if (applyAward(award.awardId, award.awards)) {
    renderScoreboard();
  }
  await saveState();
  await request("confirm-distribution");
  await publishOrdering(questionSelection());
}

function confirmCancel() {
  const dialog = root.querySelector("#ordering-cancel-dialog");
  return new Promise((resolve, reject) => {
    const finish = () => {
      dialog.removeEventListener("close", finish);
      if (dialog.returnValue === "cancel") request("cancel").then(resolve, reject);
      else resolve();
    };
    dialog.addEventListener("close", finish);
    dialog.showModal();
  });
}

function render(snapshot) {
  orderingState = snapshot;
  const round = snapshot.round;
  if (!round && selectedQuestion) renderPreview();
  else if (!round) renderOverview();
  else if (round.phase === "active") renderActive(round);
  else renderResults(round);
}

export async function mount(element) {
  root = element;
  content = root.querySelector("#ordering-content");
  statusLine = root.querySelector("#ordering-status");
  await request("configure", {
    configFingerprint: state.configFingerprint,
    teams: state.teams.map((team) => team.name),
    questionIds: state.config.ordering.questions.map((question) => question.id)
  });
  orderingState = await fetch("/api/ordering/state", { cache: "no-store" }).then((response) => response.json());
  selectedQuestion = null;
  selectedPreviewItems = [];
  await publishOrdering(questionSelection(null));
  render(orderingState);
  events = new EventSource("/api/ordering/events");
  events.addEventListener("state", (event) => {
    const snapshot = JSON.parse(event.data);
    render(snapshot);
    if (!snapshot.round) publishOrdering(questionSelection()).catch(() => undefined);
  });
  const handleScoreChange = () => publishOrdering(questionSelection()).catch(() => undefined);
  window.addEventListener("quiz-score-changed", handleScoreChange);
  ticker = setInterval(() => {
    const timer = content.querySelector(".ordering-timer");
    if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
  }, 200);
  return () => {
    events?.close();
    clearInterval(ticker);
    window.removeEventListener("quiz-score-changed", handleScoreChange);
  };
}
