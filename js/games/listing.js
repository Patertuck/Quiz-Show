import { publishListing } from "../presentation-host.js";
import { state, applyAward, saveState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";
import { formatInteger } from "../format-number.js";
import { hostFetch } from "../slot-api.js";
import { confirmAction } from "../confirm-dialog.js";
import { subscribeHostState } from "../host/live-state.js";
import { isGameSnapshot } from "./control-state.js";

let root;
let content;
let statusLine;
let listingState;
let events;
let ticker;
let selectedQuestion = null;
let rulesButton;

function questionSelection(highlightedQuestionId = selectedQuestion?.id || null) {
  return {
    questions: state.config.games.listing.questions.map(({ id, displayCategory }) => ({
      id,
      displayCategory,
      completed: listingState?.completedQuestionIds.includes(id) || false
    })),
    highlightedQuestionId,
    selectedQuestion: selectedQuestion ? {
      id: selectedQuestion.id,
      title: selectedQuestion.title,
      prompt: selectedQuestion.prompt
    } : null
  };
}

function publishQuestionSelection(highlightedQuestionId) {
  publishListing(questionSelection(highlightedQuestionId)).catch(() => undefined);
}

async function request(action, extra = {}) {
  const response = await hostFetch("/api/listing/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

function timerControl(seconds) {
  const label = document.createElement("label");
  label.className = "listing-time-control";
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

function button(label, className, onClick, disabled = false) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.disabled = disabled;
  element.addEventListener("click", async () => {
    element.disabled = true;
    try { await onClick(element); }
    catch (error) {
      console.error(error);
      setStatus(error.message);
      element.disabled = disabled;
    }
  });
  return element;
}

function renderOverview() {
  setStatus("Wählt eine Aufgabe aus.");
  const grid = document.createElement("div");
  grid.className = "listing-question-grid";
  state.config.games.listing.questions.forEach((question) => {
    const complete = listingState.completedQuestionIds.includes(question.id);
    const card = button(question.displayCategory, `listing-question-card${complete ? " completed" : ""}`, async (trigger) => {
      if (complete) {
        trigger.disabled = false;
        return;
      }
      selectedQuestion = question;
      renderPreview();
      await publishListing(questionSelection(question.id));
    });
    if (complete) {
      card.title = "Bereits abgeschlossen · mit Rechtsklick erneut freischalten";
      card.setAttribute("aria-disabled", "true");
      card.setAttribute("aria-label", `${question.displayCategory}, abgeschlossen. Mit Rechtsklick erneut freischalten.`);
      card.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        try {
          await request("reopen-question", { questionId: question.id });
          setStatus(`${question.title} kann erneut gespielt werden.`);
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
  setStatus("Der Timer startet sofort.");
  const preview = document.createElement("section");
  preview.className = "listing-preview";
  const title = document.createElement("h2");
  title.textContent = question.title;
  const prompt = document.createElement("p");
  prompt.className = "listing-preview-prompt";
  prompt.textContent = question.prompt;
  const details = document.createElement("p");
  details.textContent = `Platzierungspunkte ${question.placementPoints.join(" / ")}`;
  const timer = timerControl(question.timeLimitSeconds);
  const actions = document.createElement("div");
  actions.className = "listing-actions";
  actions.append(
    button("Starten", "primary-button", () => request("start", {
      question: { ...question, timeLimitSeconds: timerSeconds(timer.input) }
    })),
    button("Zurück", "secondary-button", async () => {
      selectedQuestion = null;
      renderOverview();
      await publishListing(questionSelection(null));
    })
  );
  preview.append(title, prompt, details, timer.label, actions);
  content.replaceChildren(preview);
}

function renderActive(round) {
  const timer = document.createElement("output");
  timer.className = "listing-timer";
  timer.dataset.deadline = round.deadlineAt;
  timer.textContent = Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000));
  setStatus(`${listingState.connectedTeamCount} Teams verbunden · ${round.submittedCount} von ${listingState.teams.length} abgegeben`);
  const panel = document.createElement("section");
  panel.className = "listing-live";
  const title = document.createElement("h2");
  title.textContent = round.prompt;
  const teams = document.createElement("div");
  teams.className = "listing-team-statuses";
  listingState.teams.forEach((name, index) => {
    const row = document.createElement("div");
    row.className = round.submitted[index] ? "submitted" : "";
    const count = round.drafts[index]?.length || 0;
    row.textContent = `${name}: ${count} Einträge${round.submitted[index] ? " · abgegeben" : ""}`;
    teams.append(row);
  });
  const actions = document.createElement("div");
  actions.className = "listing-actions";
  actions.append(
    button("Jetzt auswerten", "primary-button", () => request("lock")),
    button("Runde abbrechen", "danger-button", confirmCancel)
  );
  panel.append(title, timer, teams, actions);
  content.replaceChildren(panel);
}

async function confirmCancel(trigger) {
  const confirmed = await confirmAction({
    title: "Diese Runde abbrechen?",
    message: "Alle eingereichten Begriffe dieser Runde werden verworfen.",
    confirmLabel: "Runde abbrechen",
    cancelLabel: "Runde fortsetzen"
  });
  if (!confirmed) {
    trigger.disabled = false;
    return;
  }
  const snapshot = await request("cancel");
  selectedQuestion = null;
  render(snapshot);
  await publishListing(questionSelection(null));
}

function renderReview(round) {
  const review = round.review;
  const points = review.items.reduce((total, item) => total + (item.decision === 1 ? 1 : item.decision === -1 ? -1 : 0), 0);
  setStatus(`${listingState.teams[review.teamIndex]}: ${points} Punkte.`);
  const panel = document.createElement("section");
  panel.className = "listing-review";
  const header = document.createElement("header");
  header.className = "listing-review-header";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "listing-review-progress";
  eyebrow.textContent = `Team ${review.teamPosition + 1} von ${review.teamTotal}`;
  const team = document.createElement("h2");
  team.textContent = listingState.teams[review.teamIndex];
  const counter = document.createElement("strong");
  counter.className = "listing-review-counter";
  counter.textContent = `${points} gültig`;
  counter.setAttribute("aria-label", `${points} Punkte aus bewerteten Begriffen`);
  heading.append(eyebrow, team);
  header.append(heading, counter);

  const teamTabs = document.createElement("nav");
  teamTabs.className = "listing-review-teams";
  teamTabs.setAttribute("aria-label", "Teams in der Prüfung");
  review.teams.forEach((summary) => {
    const tab = button(
      listingState.teams[summary.teamIndex],
      `listing-review-team-tab${summary.teamIndex === review.teamIndex ? " active" : ""}`,
      () => request("review-team", { teamIndex: summary.teamIndex })
    );
    tab.setAttribute("aria-current", summary.teamIndex === review.teamIndex ? "page" : "false");
    teamTabs.append(tab);
  });

  const answers = document.createElement("div");
  answers.className = "listing-review-grid";
  review.items.forEach((item) => {
    const card = document.createElement("article");
    card.className = `listing-review-item ${decisionClass(item.decision)}`;
    const answer = document.createElement("p");
    answer.className = "listing-review-answer";
    answer.textContent = item.text;
    const controls = document.createElement("div");
    controls.className = "listing-decision-actions";
    for (const [impact, label, className, description] of [
      [1, "+1", "listing-accept", "richtig"],
      [0, "0", "listing-reject-neutral", "falsch ohne Abzug"],
      [-1, "−1", "listing-reject", "falsch mit Abzug"]
    ]) {
      const selected = item.decision === impact;
      const control = button(label, `${className}${selected ? " selected" : ""}`,
        () => request("decide", { itemId: item.itemId, countImpact: impact }));
      control.setAttribute("aria-label", `${item.text}: ${description}, ${label} ${selected ? "ausgewählt" : "setzen"}`);
      control.setAttribute("aria-pressed", String(selected));
      controls.append(control);
    }
    card.append(answer, controls);
    answers.append(card);
  });

  const navigation = document.createElement("div");
  navigation.className = "listing-actions";
  const previous = review.teams[review.teamPosition - 1]?.teamIndex;
  const next = review.teams[review.teamPosition + 1]?.teamIndex;
  navigation.append(
    button("← Vorheriges Team", "secondary-button", () => request("review-team", { teamIndex: previous }), previous === undefined),
    button("Nächstes Team →", "secondary-button", () => request("review-team", { teamIndex: next }), next === undefined),
    button("Prüfung abschliessen", "primary-button", () => request("finish-review"), review.decidedCount < review.total),
    button("Runde abbrechen", "danger-button", confirmCancel)
  );
  panel.append(header, teamTabs, answers, navigation);
  content.replaceChildren(panel);
}

function decisionClass(decision) {
  if (decision === 1 || decision === true) return "decision-positive";
  if (decision === -1) return "decision-negative";
  if (decision === 0 || decision === false) return "decision-neutral";
  return "decision-pending";
}

function resultTable(round) {
  const table = document.createElement("div");
  table.className = "listing-results";
  [...round.results].sort((a, b) => a.place - b.place || a.teamIndex - b.teamIndex).forEach((result) => {
    const row = document.createElement("div");
    row.className = "listing-result-row";
    const place = document.createElement("strong");
    place.textContent = `${result.place}.`;
    const name = document.createElement("span");
    name.textContent = listingState.teams[result.teamIndex];
    const count = document.createElement("span");
    count.textContent = `${result.acceptedCount} gültig`;
    const points = document.createElement("strong");
    points.textContent = `+${formatInteger(result.points)}`;
    row.append(place, name, count, points);
    table.append(row);
  });
  return table;
}

function renderRanking(round) {
  setStatus(round.phase === "distributed" ? "Punkte wurden verteilt." : "Ergebnisse bereit.");
  const panel = document.createElement("section");
  panel.className = "listing-result-panel";
  const title = document.createElement("h2");
  title.textContent = "Rangliste";
  const actions = document.createElement("div");
  actions.className = "listing-actions";
  if (round.phase === "distributed") {
    actions.append(button("Zurück zu den Aufgaben", "primary-button", () => request("close")));
  } else {
    actions.append(
      button("Punkte verteilen", "primary-button", distribute),
      button("Runde abbrechen", "danger-button", confirmCancel)
    );
  }
  panel.append(title, resultTable(round), actions);
  content.replaceChildren(panel);
}

function renderResults(round) {
  renderRanking(round);
}

async function distribute() {
  const award = await request("awards");
  if (applyAward(award.awardId, award.awards, "listing")) renderScoreboard();
  await saveState();
  await request("confirm-distribution");
  await publishListing(questionSelection());
}

function render(snapshot) {
  listingState = snapshot;
  const round = snapshot.round;
  rulesButton.hidden = Boolean(round);
  if (!round && selectedQuestion) renderPreview();
  else if (!round) renderOverview();
  else if (round.phase === "active") renderActive(round);
  else if (round.phase === "review") renderReview(round);
  else renderResults(round);
}

export async function mount(element, { showRules } = {}) {
  root = element;
  content = root.querySelector("#listing-content");
  statusLine = root.querySelector("#listing-status");
  rulesButton = root.querySelector("#listing-rules-button");
  rulesButton.addEventListener("click", () => showRules().catch((error) => setStatus(error.message)));
  await request("configure", {
    teams: state.teams.map((team) => team.name),
    questionIds: state.config.games.listing.questions.map((question) => question.id)
  });
  selectedQuestion = null;
  listingState = await hostFetch("/api/listing/state", { cache: "no-store" }).then((response) => response.json());
  await publishListing(questionSelection(null));
  render(listingState);
  events = subscribeHostState("listing", (snapshot) => {
    render(snapshot);
    if (!snapshot.round) publishListing(questionSelection()).catch(() => undefined);
  });
  const scoreListener = (event) => {
    if (event.detail?.source !== "manual") publishListing(questionSelection()).catch(() => undefined);
  };
  window.addEventListener("quiz-score-changed", scoreListener);
  ticker = setInterval(() => {
    const timer = content.querySelector(".listing-timer");
    if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
  }, 200);
  return () => {
    events?.();
    clearInterval(ticker);
    window.removeEventListener("quiz-score-changed", scoreListener);
  };
}
