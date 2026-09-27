import { publishOrdering } from "../presentation-host.js";
import { state, applyAward, saveState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";
import { hostFetch } from "../slot-api.js";
import { confirmAction } from "../confirm-dialog.js";
import { scheduleTextFit } from "../fit-text.js";
import { formatInteger } from "../format-number.js";
import { subscribeHostState } from "../host/live-state.js";
import { isGameSnapshot } from "./control-state.js";

let root;
let content;
let headingTitle;
let statusLine;
let orderingState;
let events;
let ticker;
let resultFitObserver;
let previewFitFrame;
let selectedQuestion = null;
let selectedPreviewItems = [];
let visibleMapItem = null;
let rulesButton;
let privateSolutionRoundId = null;
let privateSolutionPreview = false;

async function request(action, extra = {}) {
  const response = await hostFetch("/api/ordering/control", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  if (isGameSnapshot(payload)) render(payload);
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
    try { await onClick(element); }
    catch (error) { console.error(error); setStatus(error.message); element.disabled = disabled; }
  });
  return element;
}

function itemText(itemId, round) {
  return round.shuffledItems.find((item) => item.id === itemId)?.text || itemId;
}

function privateSolutionToggle(label) {
  const control = button(privateSolutionPreview ? label : "Lösung ansehen", "secondary-button ordering-private-solution-toggle", () => {
    privateSolutionPreview = !privateSolutionPreview;
    render(orderingState);
  });
  control.setAttribute("aria-pressed", String(privateSolutionPreview));
  return control;
}

function remaining(round) {
  return Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000));
}

function timerControl(seconds) {
  const label = document.createElement("label");
  label.className = "ordering-time-control";
  label.append("Zeit (Sekunden)");
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.required = true;
  input.value = String(seconds);
  label.append(input);
  return { label, input };
}

function timerSeconds(input) {
  const seconds = input.valueAsNumber;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    input.focus();
    throw new Error("Die Zeit muss eine positive Ganzzahl sein.");
  }
  return seconds;
}

function fitResultText(scope = content) {
  scope?.querySelectorAll(".ordering-result-cell").forEach((cell) => {
    scheduleTextFit(cell, ".ordering-cell-text", { maxHeightRatio: 0.28 });
  });
}

function fitPreview() {
  const preview = content?.querySelector(".ordering-preview");
  const actions = content?.querySelector(".ordering-preview + .ordering-actions");
  if (!preview || !actions) return;
  preview.style.removeProperty("--ordering-preview-scale");
  const contentTop = content.getBoundingClientRect().top;
  const actionsTop = actions.getBoundingClientRect().top;
  const gap = Number.parseFloat(getComputedStyle(content).rowGap) || 0;
  const availableHeight = Math.max(1, actionsTop - contentTop - gap);
  const scale = Math.min(1, availableHeight / preview.offsetHeight);
  preview.style.setProperty("--ordering-preview-scale", scale.toFixed(4));
}

function schedulePreviewFit() {
  cancelAnimationFrame(previewFitFrame);
  previewFitFrame = requestAnimationFrame(fitPreview);
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
    questions: state.config.games.ordering.questions.map(({ id, title }) => ({
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
  publishOrdering(questionSelection(highlightedQuestionId), orderingMap()).catch(() => undefined);
}

function orderingMap() {
  const question = selectedQuestion || state.config.games.ordering.questions.find((item) => item.id === orderingState?.round?.questionId);
  if (visibleMapItem === "__solution__" && question?.solutionImage) {
    return { label: "Auswertung", image: question.solutionImage };
  }
  const image = visibleMapItem && question?.itemMaps?.[visibleMapItem];
  return image ? { label: visibleMapItem, image } : null;
}

async function toggleMap(item) {
  visibleMapItem = visibleMapItem === item ? null : item;
  render(orderingState);
  await publishOrdering(questionSelection(), orderingMap());
}

function renderOverview() {
  setStatus("Wählt eine Frage aus.");
  const grid = document.createElement("div");
  grid.className = "ordering-question-grid";
  state.config.games.ordering.questions.forEach((question) => {
    const complete = orderingState.completedQuestionIds.includes(question.id);
    const card = button(question.title, `ordering-question-card${complete ? " completed" : ""}`, async (trigger) => {
      if (complete) {
        trigger.disabled = false;
        return;
      }
      selectedQuestion = question;
      selectedPreviewItems = shuffled(question.items);
      visibleMapItem = null;
      renderPreview();
      publishQuestionSelection(question.id);
    });
    if (complete) {
      card.title = "Bereits abgeschlossen · mit Rechtsklick erneut freischalten";
      card.setAttribute("aria-disabled", "true");
      card.setAttribute("aria-label", `${question.title}, abgeschlossen. Mit Rechtsklick erneut freischalten.`);
      card.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        try {
          orderingState = await request("reopen-question", { questionId: question.id });
          renderOverview();
          setStatus(`${question.title} kann erneut gespielt werden.`);
          await publishOrdering(questionSelection(null), null);
        } catch (error) {
          console.error(error);
          setStatus(error.message);
        }
      });
    }
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
  const scoringMode = state.config.games.ordering.scoringMode || "relative";
  const points = state.config.games.ordering.pointsPerCorrect;
  const maximum = scoringMode === "relative"
    ? question.items.length * (question.items.length - 1) / 2 * points
    : question.items.length * points;
  setStatus();
  const preview = document.createElement("section"); preview.className = "ordering-preview";
  const title = document.createElement("h2"); title.textContent = question.title;
  const prompt = document.createElement("p"); prompt.textContent = question.prompt;
  const unit = scoringMode === "relative" ? "richtigem Paar" : "richtiger Position";
  const details = document.createElement("p"); details.textContent = `${question.items.length} Elemente · ${formatInteger(points)} Punkte pro ${unit} · maximal ${formatInteger(maximum)} Punkte`;
  const timer = timerControl(question.timeLimitSeconds);
  const list = document.createElement("ol");
  question.items.forEach((text) => { const item = document.createElement("li"); item.textContent = text; list.append(item); });
  preview.append(title, prompt, details, timer.label, list);
  const actions = document.createElement("div"); actions.className = "ordering-actions";
  actions.append(
    button("Starten", "primary-button", () => request("start", {
      question: { ...question, timeLimitSeconds: timerSeconds(timer.input), pointsPerCorrect: points, scoringMode }
    })),
    button("Zurück", "secondary-button", async () => {
      selectedQuestion = null;
      selectedPreviewItems = [];
      visibleMapItem = null;
      renderOverview();
      publishQuestionSelection(null);
    })
  );
  content.replaceChildren(preview, actions);
  schedulePreviewFit();
}

function renderActive(round) {
  const timer = document.createElement("div");
  timer.className = "ordering-timer";
  timer.dataset.deadline = round.deadlineAt;
  timer.textContent = remaining(round);
  setStatus(round.prompt);
  const connected = document.createElement("p");
  connected.className = "ordering-connected";
  connected.textContent = `${orderingState.connectedTeamCount} ${orderingState.connectedTeamCount === 1 ? "Team verbunden" : "Teams verbunden"}`;
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
  const actions = document.createElement("div"); actions.className = "ordering-actions";
  actions.append(
    privateSolutionToggle("Teams ansehen"),
    button("Antworten sperren", "primary-button", () => request("lock")),
    button("Runde abbrechen", "danger-button", confirmCancel)
  );
  content.replaceChildren(timer, connected, columns, actions);
}

function teamColumn(round, teamIndex) {
  const column = document.createElement("section");
  column.className = "ordering-result-column";
  column.style.setProperty("--ordering-count", round.correctItems.length);
  const heading = document.createElement("h2");
  heading.innerHTML = `<span></span><strong></strong>`;
  heading.querySelector("span").textContent = orderingState.teams[teamIndex];
  heading.querySelector("strong").textContent = round.pointsRevealed ? `+${formatInteger(round.roundPoints[teamIndex])}` : "";
  column.append(heading);
  const correct = round.correctItems.map((item) => item.id);
  round.teamOrders[teamIndex].forEach((id, slot) => {
    const cell = document.createElement("div");
    cell.className = "ordering-result-cell";
    const revealed = round.revealed.includes(slot);
    if (revealed && round.scoringMode === "exact") cell.classList.add(id === correct[slot] ? "correct" : "wrong");
    if (revealed && round.scoringMode === "relative") cell.classList.add("relative-revealed");
    const label = document.createElement("span");
    label.className = "ordering-cell-text";
    label.textContent = itemText(id, round);
    cell.append(label);
    if (revealed && round.scoringMode === "relative" && round.pointsRevealed) {
      const points = document.createElement("strong");
      points.className = `ordering-row-points${round.phase === "distributed" ? " settled" : ""}`;
      const value = round.rowPoints[teamIndex][slot];
      if (value === 0) points.classList.add("zero");
      points.textContent = `+${formatInteger(value)}`;
      cell.append(points);
    }
    column.append(cell);
  });
  return column;
}

function renderResults(round) {
  const allRevealed = round.revealed.length === round.correctItems.length;
  setStatus(round.prompt);
  const layout = document.createElement("div"); layout.className = "ordering-results-layout";
  const board = document.createElement("div"); board.className = "ordering-results";
  const split = Math.ceil(orderingState.teams.length / 2);
  const left = document.createElement("div"); left.className = "ordering-result-side";
  const right = document.createElement("div"); right.className = "ordering-result-side";
  orderingState.teams.forEach((_, index) => (index < split ? left : right).append(teamColumn(round, index)));
  const solution = document.createElement("section"); solution.className = "ordering-result-column ordering-solution";
  solution.style.setProperty("--ordering-count", round.correctItems.length);
  const title = document.createElement("h2");
  if (privateSolutionPreview) {
    const label = document.createElement("span"); label.textContent = "Richtige Reihenfolge";
    const privateLabel = document.createElement("strong"); privateLabel.textContent = "Nur Spielleitung";
    title.append(label, privateLabel);
    solution.classList.add("private-preview");
  } else {
    title.textContent = "Richtige Reihenfolge";
  }
  solution.append(title);
  round.correctItems.forEach((item, slot) => {
    const revealed = round.revealed.includes(slot);
    const privatelyVisible = privateSolutionPreview && !revealed;
    const control = button("", `ordering-result-cell solution-cell${revealed ? " revealed" : ""}${privatelyVisible ? " private-preview" : ""}`,
      () => request("reveal", { slot }), revealed || privatelyVisible || round.phase === "distributed");
    const label = document.createElement("span");
    label.className = "ordering-cell-text";
    label.textContent = revealed || privatelyVisible ? item.text : `Position ${slot + 1} aufdecken`;
    control.append(label);
    solution.append(control);
  });
  board.append(left, solution, right);
  const mapQuestion = selectedQuestion || state.config.games.ordering.questions.find((item) => item.id === round.questionId);
  const mapItems = mapQuestion?.itemMaps
    ? round.correctItems.filter((item) => mapQuestion.itemMaps[item.text])
    : [];
  const mapActions = document.createElement("div"); mapActions.className = "ordering-actions ordering-map-actions";
  mapItems.forEach((item) => {
    const active = visibleMapItem === item.text;
    const control = button(active ? `${item.text} ausblenden` : `${item.text} zeigen`, active ? "primary-button" : "secondary-button",
      () => toggleMap(item.text));
    control.setAttribute("aria-pressed", String(active));
    mapActions.append(control);
  });
  if (mapQuestion?.solutionImage) {
    const active = visibleMapItem === "__solution__";
    const control = button(active ? "Bild ausblenden" : "Bild zeigen",
      active ? "primary-button" : "secondary-button", () => toggleMap("__solution__"));
    control.setAttribute("aria-pressed", String(active));
    mapActions.append(control);
  }
  const actions = document.createElement("div"); actions.className = "ordering-actions";
  if (round.phase === "active") {
    actions.append(
      privateSolutionToggle("Teams ansehen"),
      button("Antworten sperren", "primary-button", () => request("lock")),
      button("Runde abbrechen", "danger-button", confirmCancel)
    );
  } else if (round.phase === "distributed") {
    actions.append(button("Zurück zu den Fragen", "primary-button", async () => {
      visibleMapItem = null;
      await publishOrdering(questionSelection(), null);
      await request("close");
    }));
  } else {
    if (round.pointsRevealed) actions.append(button("Punkte verteilen", "primary-button", distribute));
    else actions.append(button("Punkte anzeigen", "primary-button", () => request("reveal-points"), !allRevealed));
    actions.append(button("Runde abbrechen", "danger-button", confirmCancel));
  }
  const footer = document.createElement("div"); footer.className = "ordering-results-footer";
  if (mapItems.length || mapQuestion?.solutionImage) footer.append(mapActions);
  if (round.phase !== "active" && !allRevealed) actions.prepend(privateSolutionToggle("Ergebnisse ansehen"));
  footer.append(actions);
  layout.append(board, footer);
  content.replaceChildren(layout);
  fitResultText();
}

async function distribute() {
  const award = await request("awards");
  if (applyAward(award.awardId, award.awards, "ordering")) {
    renderScoreboard();
  }
  await saveState();
  await request("confirm-distribution");
  await publishOrdering(questionSelection(), orderingMap());
}

async function confirmCancel(trigger) {
  const confirmed = await confirmAction({
    title: "Diese Runde abbrechen?",
    message: "Alle für diese Frage eingereichten Reihenfolgen werden verworfen.",
    confirmLabel: "Runde abbrechen",
    cancelLabel: "Runde fortsetzen"
  });
  if (!confirmed) {
    trigger.disabled = false;
    return;
  }
  const snapshot = await request("cancel");
  selectedQuestion = null;
  selectedPreviewItems = [];
  visibleMapItem = null;
  render(snapshot);
  await publishOrdering(questionSelection(null), null);
}

function render(snapshot) {
  orderingState = snapshot;
  const round = snapshot.round;
  const nextRoundId = round?.id || null;
  if (nextRoundId !== privateSolutionRoundId) {
    privateSolutionRoundId = nextRoundId;
    privateSolutionPreview = false;
  }
  if (round && round.revealed.length === round.correctItems.length) privateSolutionPreview = false;
  headingTitle.textContent = round?.title || "Order Up";
  rulesButton.hidden = Boolean(round);
  if (!round && selectedQuestion) renderPreview();
  else if (!round) renderOverview();
  else if (round.phase === "active" && !privateSolutionPreview) renderActive(round);
  else renderResults(round);
}

export async function mount(element, { showRules } = {}) {
  root = element;
  content = root.querySelector("#ordering-content");
  headingTitle = root.querySelector(".ordering-heading h1");
  statusLine = root.querySelector("#ordering-status");
  rulesButton = root.querySelector("#ordering-rules-button");
  rulesButton.addEventListener("click", () => showRules().catch((error) => setStatus(error.message)));
  await request("configure", {
    teams: state.teams.map((team) => team.name),
    questionIds: state.config.games.ordering.questions.map((question) => question.id)
  });
  orderingState = await hostFetch("/api/ordering/state", { cache: "no-store" }).then((response) => response.json());
  selectedQuestion = null;
  selectedPreviewItems = [];
  visibleMapItem = null;
  await publishOrdering(questionSelection(null));
  render(orderingState);
  events = subscribeHostState("ordering", (snapshot) => {
    render(snapshot);
    if (!snapshot.round) publishOrdering(questionSelection()).catch(() => undefined);
  });
  const handleScoreChange = (event) => {
    if (event.detail?.source !== "manual") {
      publishOrdering(questionSelection(), orderingMap()).catch(() => undefined);
    }
  };
  window.addEventListener("quiz-score-changed", handleScoreChange);
  ticker = setInterval(() => {
    const timer = content.querySelector(".ordering-timer");
    if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
  }, 200);
  resultFitObserver = new ResizeObserver(() => {
    fitResultText();
    schedulePreviewFit();
  });
  resultFitObserver.observe(content);
  return () => {
    events?.();
    clearInterval(ticker);
    cancelAnimationFrame(previewFitFrame);
    resultFitObserver?.disconnect();
    window.removeEventListener("quiz-score-changed", handleScoreChange);
  };
}
