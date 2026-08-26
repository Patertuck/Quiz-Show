import { publishSync } from "../presentation-host.js";
import { state, applyAward, saveState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";

let root;
let content;
let statusLine;
let syncState;
let events;
let ticker;

async function request(action, extra = {}) {
  const response = await fetch("/api/sync/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function button(label, className, onClick, disabled = false) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = className;
  item.textContent = label;
  item.disabled = disabled;
  item.addEventListener("click", async () => {
    item.disabled = true;
    try { await onClick(); }
    catch (error) {
      console.error(error);
      statusLine.textContent = error.message;
      item.disabled = disabled;
    }
  });
  return item;
}

function participantName(id) {
  return syncState.participants.find((item) => item.id === id)?.name || "Keine Auswahl";
}

function renderLobby() {
  const connected = new Set(syncState.connectedParticipantIds || []);
  statusLine.textContent = syncState.rosterLocked
    ? "Die Teilnehmerliste ist gesperrt. Wählt einen Prompt."
    : "Alle Mitspielenden wählen auf dem Handy ihr Team und tragen ihren Namen ein.";
  const teams = document.createElement("div");
  teams.className = "sync-roster";
  syncState.teams.forEach((team, teamIndex) => {
    const card = document.createElement("section");
    card.className = "sync-roster-team";
    const title = document.createElement("h2");
    title.textContent = team;
    card.append(title);
    const members = syncState.participants.filter((item) => item.teamIndex === teamIndex);
    if (!members.length) card.append(Object.assign(document.createElement("p"), { textContent: "Noch niemand registriert" }));
    members.forEach((member) => {
      const row = document.createElement("div");
      row.className = `sync-roster-person${connected.has(member.id) ? " connected" : ""}`;
      row.textContent = member.name;
      card.append(row);
    });
    teams.append(card);
  });
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  if (!syncState.rosterLocked) {
    actions.append(
      button("Teilnehmerliste sperren", "primary-button", () => request("lock-roster")),
      button("Testspieler hinzufügen", "secondary-button", () => request("seed-test-players"))
    );
  } else {
    actions.append(button("Teilnehmerliste entsperren", "secondary-button", () => request("unlock-roster")));
  }
  content.replaceChildren(teams, actions);
}

function renderOverview() {
  statusLine.textContent = "Wählt den nächsten Prompt oder beendet Sync Up.";
  const layout = document.createElement("div");
  layout.className = "sync-overview";
  const prompts = document.createElement("div");
  prompts.className = "sync-question-grid";
  state.config.games.sync.questions.forEach((question) => {
    const complete = syncState.completedQuestionIds.includes(question.id);
    prompts.append(button(question.prompt, `sync-question-card${complete ? " completed" : ""}`, () => request("prepare", {
      question: {
        ...question,
        timeLimitSeconds: state.config.games.sync.timeLimitSeconds,
        pointsPerSync: state.config.games.sync.pointsPerSync
      }
    }), complete));
  });
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  actions.append(
    button("Spiel zurücksetzen", "danger-button", async () => {
      if (window.confirm("Teilnehmer, Antworten und Sync-Punkte wirklich löschen?")) await request("reset-game");
    })
  );
  layout.append(prompts);
  content.replaceChildren(layout, actions);
}

function renderPrepared(round) {
  statusLine.textContent = "Lest den Prompt vor. Der Countdown beginnt erst mit «Timer starten».";
  const panel = document.createElement("section");
  panel.className = "sync-prompt-panel";
  const prompt = document.createElement("h2");
  prompt.textContent = round.prompt;
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  actions.append(
    button("Timer starten", "primary-button", () => request("start")),
    button("Abbrechen", "danger-button", () => request("cancel"))
  );
  panel.append(prompt, Object.assign(document.createElement("div"), {
    className: "sync-host-timer", textContent: String(round.timeLimitSeconds)
  }), actions);
  content.replaceChildren(panel);
}

function renderActive(round) {
  statusLine.textContent = `${round.submittedCount} von ${syncState.participants.length} Antworten gewählt`;
  const panel = document.createElement("section");
  panel.className = "sync-prompt-panel";
  const prompt = document.createElement("h2");
  prompt.textContent = round.prompt;
  const timer = document.createElement("output");
  timer.className = "sync-host-timer";
  timer.dataset.deadline = round.deadlineAt;
  timer.textContent = Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000));
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  actions.append(
    button("Testspieler abstimmen lassen", "secondary-button", () => request("vote-test-players")),
    button("Runde abbrechen", "danger-button", () => request("cancel"))
  );
  panel.replaceChildren(prompt, timer, actions);
  content.replaceChildren(panel);
}

function resultTeams(round) {
  const grid = document.createElement("div");
  grid.className = "sync-result-teams";
  round.results.forEach((result) => {
    const card = document.createElement("section");
    card.className = `sync-result-team${result.synced ? " synced" : ""}`;
    const title = document.createElement("h2");
    title.textContent = syncState.teams[result.teamIndex];
    const points = document.createElement("strong");
    points.className = "sync-result-points";
    points.textContent = `+${result.points}`;
    card.dataset.teamIndex = result.teamIndex;
    card.append(title, points);
    result.votes.forEach((vote) => {
      const voter = participantName(vote.participantId);
      const choice = participantName(vote.selectedParticipantId);
      const row = document.createElement("div");
      row.className = "sync-result-vote";
      row.textContent = `${voter} → ${choice}`;
      card.append(row);
    });
    grid.append(card);
  });
  return grid;
}

function renderResults(round) {
  root.querySelector(".sync-heading").hidden = true;
  statusLine.textContent = "";
  const heading = document.createElement("h2");
  heading.className = "sync-result-prompt";
  heading.textContent = round.prompt;
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  if (round.phase === "distributed") {
    actions.append(button("Weiter", "primary-button", () => request("close")));
  } else {
    actions.append(
      button("Punkte verteilen", "primary-button", distribute),
      button("Frage abbrechen", "danger-button", () => request("cancel"))
    );
  }
  content.replaceChildren(heading, resultTeams(round), actions);
}

async function distribute() {
  const award = await request("awards");
  if (applyAward(award.awardId, award.awards, "sync")) renderScoreboard();
  await saveState();
  await request("confirm-distribution");
  await publishSync();
}

function render(snapshot) {
  syncState = snapshot;
  root.querySelector(".sync-heading").hidden = false;
  if (syncState.round?.phase === "prepared") renderPrepared(syncState.round);
  else if (syncState.round?.phase === "active") renderActive(syncState.round);
  else if (["results", "distributed"].includes(syncState.round?.phase)) renderResults(syncState.round);
  else if (!syncState.rosterLocked) renderLobby();
  else renderOverview();
}

export async function mount(element) {
  root = element;
  content = root.querySelector("#sync-content");
  statusLine = root.querySelector("#sync-status");
  await request("configure", {
    configFingerprint: state.configFingerprint,
    teams: state.teams.map((team) => team.name),
    questionIds: state.config.games.sync.questions.map((question) => question.id)
  });
  await publishSync();
  render(await fetch("/api/sync/state", { cache: "no-store" }).then((response) => response.json()));
  events = new EventSource("/api/sync/events");
  events.addEventListener("state", (event) => {
    render(JSON.parse(event.data));
    publishSync().catch(() => undefined);
  });
  ticker = setInterval(() => {
    const timer = content.querySelector(".sync-host-timer[data-deadline]");
    if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
  }, 100);
  return () => {
    events?.close();
    clearInterval(ticker);
  };
}
