import { publishListing } from "../presentation-host.js";
import { state, applyAward, saveState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";
import { scheduleTextFit } from "../fit-text.js";
import { hostFetch, slotUrl } from "../slot-api.js";
import { confirmAction } from "../confirm-dialog.js";

let root;
let content;
let statusLine;
let listingState;
let events;
let ticker;
let resultFitObserver;
let selectedQuestion = null;

function fitResultItems(scope = content) {
  scope?.querySelectorAll(".listing-result-item").forEach((card) => {
    scheduleTextFit(card, ".listing-result-item-text");
  });
}

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
    const card = button(question.displayCategory, `listing-question-card${complete ? " completed" : ""}`, async () => {
      if (complete) return;
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
  details.textContent = `${question.timeLimitSeconds} Sekunden · maximal ${question.maxItems} Einträge · Platzierungspunkte ${question.placementPoints.join(" / ")}`;
  const rule = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Private Prüfregel";
  const ruleText = document.createElement("p");
  ruleText.textContent = question.validationRule;
  rule.append(summary, ruleText);
  const actions = document.createElement("div");
  actions.className = "listing-actions";
  actions.append(
    button("Starten", "primary-button", () => request("start", { question })),
    button("Zurück", "secondary-button", async () => {
      selectedQuestion = null;
      renderOverview();
      await publishListing(questionSelection(null));
    })
  );
  preview.append(title, prompt, details, rule, actions);
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
  setStatus(`${review.decidedCount} von ${review.total} Entscheidungen getroffen.`);
  const panel = document.createElement("section");
  panel.className = "listing-review";
  const progress = document.createElement("p");
  progress.className = "listing-review-progress";
  progress.textContent = `Eintrag ${review.index + 1} von ${review.total}`;
  const team = document.createElement("p");
  team.className = "listing-review-team";
  team.textContent = listingState.teams[review.teamIndex];
  const answer = document.createElement("h2");
  answer.textContent = review.text;
  const decisions = document.createElement("div");
  decisions.className = "listing-decision-actions";
  decisions.append(
    button("✓ Richtig (+1)", `listing-accept${review.decision === 1 || review.decision === true ? " selected" : ""}`,
      () => request("decide", { itemId: review.itemId, countImpact: 1 })),
    button("✕ Falsch (−1)", `listing-reject${review.decision === -1 ? " selected" : ""}`,
      () => request("decide", { itemId: review.itemId, countImpact: -1 })),
    button("Falsch (0)", `listing-reject-neutral${review.decision === 0 || review.decision === false ? " selected" : ""}`,
      () => request("decide", { itemId: review.itemId, countImpact: 0 }))
  );
  const navigation = document.createElement("div");
  navigation.className = "listing-actions";
  navigation.append(
    button("← Zurück", "secondary-button", () => request("navigate", { index: review.index - 1 }), review.index === 0),
    button("Weiter →", "secondary-button", () => request("navigate", { index: review.index + 1 }), review.index + 1 >= review.total),
    button("Prüfung abschliessen", "primary-button", () => request("finish-review"), review.decidedCount < review.total),
    button("Runde abbrechen", "danger-button", confirmCancel)
  );
  panel.append(progress, team, answer, decisions, navigation);
  content.replaceChildren(panel);
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
    points.textContent = `+${result.points}`;
    row.append(place, name, count, points);
    table.append(row);
  });
  return table;
}

function resultItems(items) {
  const list = document.createElement("div");
  list.className = "listing-result-items";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "listing-result-empty";
    empty.textContent = "Keine Begriffe eingereicht";
    list.append(empty);
    return list;
  }
  items.forEach((item) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `listing-result-item ${item.status}`;
    card.title = `${item.text} · Anklicken, um als ${item.accepted ? "falsch" : "richtig"} zu markieren`;
    card.setAttribute("aria-label", `${item.text}: ${item.accepted ? "richtig" : "falsch"}. Zum Ändern anklicken.`);
    card.setAttribute("aria-pressed", String(item.accepted));
    const text = document.createElement("span");
    text.className = "listing-result-item-text";
    text.textContent = item.text;
    card.append(text);
    card.addEventListener("click", async () => {
      card.disabled = true;
      try {
        await request("toggle-result-item", { itemId: item.itemId });
      } catch (error) {
        card.disabled = false;
        setStatus(error.message);
      }
    });
    list.append(card);
  });
  return list;
}

function renderTeamResult(round) {
  const position = round.resultView?.teamPosition || 0;
  const result = round.results[position];
  if (!result) {
    request("result-ranking").catch((error) => setStatus(error.message));
    return;
  }
  setStatus(`Teamseite ${position + 1} von ${round.results.length} · absteigend nach Platzierung.`);
  const panel = document.createElement("section");
  panel.className = "listing-team-result-panel";
  const heading = document.createElement("header");
  heading.className = "listing-team-result-heading";
  const place = document.createElement("strong");
  place.textContent = `${result.place}. Platz`;
  const title = document.createElement("h2");
  title.textContent = listingState.teams[result.teamIndex];
  const count = document.createElement("span");
  count.textContent = `${result.acceptedCount} Punkte`;
  heading.append(place, title, count);
  const actions = document.createElement("div");
  actions.className = "listing-actions";
  actions.append(
    button("← Vorheriges Team", "secondary-button",
      () => request("result-navigate", { teamPosition: position - 1 }), position === 0),
    button("Nächstes Team →", "secondary-button",
      () => request("result-navigate", { teamPosition: position + 1 }), position + 1 >= round.results.length),
    button("Direkt zur Rangliste", "primary-button", () => request("result-ranking")),
    button("Runde abbrechen", "danger-button", confirmCancel)
  );
  panel.append(heading, resultItems(result.items || []), actions);
  content.replaceChildren(panel);
  fitResultItems(panel);
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
      button("Teamseiten anzeigen", "secondary-button", () => request("result-teams")),
      button("Punkte verteilen", "primary-button", distribute),
      button("Runde abbrechen", "danger-button", confirmCancel)
    );
  }
  panel.append(title, resultTable(round), actions);
  content.replaceChildren(panel);
}

function renderResults(round) {
  if (round.phase === "results" && round.resultView?.mode === "team") renderTeamResult(round);
  else renderRanking(round);
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
  if (!round && selectedQuestion) renderPreview();
  else if (!round) renderOverview();
  else if (round.phase === "active") renderActive(round);
  else if (round.phase === "review") renderReview(round);
  else renderResults(round);
}

export async function mount(element) {
  root = element;
  content = root.querySelector("#listing-content");
  statusLine = root.querySelector("#listing-status");
  await request("configure", {
    teams: state.teams.map((team) => team.name),
    questionIds: state.config.games.listing.questions.map((question) => question.id)
  });
  selectedQuestion = null;
  listingState = await hostFetch("/api/listing/state", { cache: "no-store" }).then((response) => response.json());
  await publishListing(questionSelection(null));
  render(listingState);
  events = new EventSource(slotUrl("/api/listing/events"));
  events.addEventListener("state", (event) => {
    const snapshot = JSON.parse(event.data);
    render(snapshot);
    if (!snapshot.round) publishListing(questionSelection()).catch(() => undefined);
  });
  resultFitObserver = new ResizeObserver(() => fitResultItems());
  resultFitObserver.observe(content);
  const scoreListener = () => publishListing(questionSelection()).catch(() => undefined);
  window.addEventListener("quiz-score-changed", scoreListener);
  ticker = setInterval(() => {
    const timer = content.querySelector(".listing-timer");
    if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
  }, 200);
  return () => {
    events?.close();
    resultFitObserver?.disconnect();
    resultFitObserver = null;
    clearInterval(ticker);
    window.removeEventListener("quiz-score-changed", scoreListener);
  };
}
