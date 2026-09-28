import { publishSync } from "../presentation-host.js";
import { state, applyAward, recordAnalyticsEvent, saveState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";
import { hostFetch } from "../slot-api.js";
import { confirmAction } from "../confirm-dialog.js";
import { subscribeHostState } from "../host/live-state.js";
import { isGameSnapshot } from "./control-state.js";
import { formatInteger } from "../format-number.js";

let root;
let content;
let statusLine;
let syncState;
let events;
let ticker;
let rulesButton;

async function request(action, extra = {}) {
  const response = await hostFetch("/api/sync/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  if (isGameSnapshot(payload)) render(payload);
  return payload;
}

function timerControl(seconds) {
  const label = document.createElement("label");
  label.className = "sync-time-control";
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
  const item = document.createElement("button");
  item.type = "button";
  item.className = className;
  item.textContent = label;
  item.disabled = disabled;
  item.addEventListener("click", async () => {
    item.disabled = true;
    try { await onClick(item); }
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
  syncState.syncTeams.forEach((team) => {
    const card = document.createElement("section");
    card.className = "sync-roster-team";
    const title = document.createElement("h2");
    title.textContent = team.name;
    card.append(title);
    const members = syncState.participants.filter((item) => item.syncTeamId === team.id);
    if (!members.length) card.append(Object.assign(document.createElement("p"), { textContent: "Noch niemand registriert" }));
    members.forEach((member) => {
      const row = document.createElement("div");
      row.className = `sync-roster-person${connected.has(member.id) ? " connected" : ""}`;
      const name = document.createElement("span");
      name.textContent = member.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "sync-delete-person";
      remove.textContent = "×";
      remove.title = `${member.name} entfernen`;
      remove.setAttribute("aria-label", `${member.name} aus dem Sync-Up-Team entfernen`);
      remove.addEventListener("click", () => confirmDeleteParticipant(member, team, remove));
      row.append(name, remove);
      card.append(row);
    });
    const mapping = document.createElement("div");
    mapping.className = "sync-team-mapping";
    syncState.teams.forEach((quizTeam, quizTeamIndex) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = team.quizTeamIndices.includes(quizTeamIndex);
      input.disabled = syncState.rosterLocked;
      input.addEventListener("change", async () => {
        if (!input.checked) { input.checked = true; return; }
        try { await request("map-quiz-team", { syncTeamId: team.id, quizTeamIndex }); }
        catch (error) { statusLine.textContent = error.message; }
      });
      label.append(input, ` ${quizTeam}`);
      mapping.append(label);
    });
    card.append(mapping);
    if (!syncState.rosterLocked) {
      card.append(button("Team löschen", "danger-button sync-delete-team", (trigger) =>
        confirmDeleteSyncTeam(team, members.length, trigger)));
    }
    teams.append(card);
  });
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  if (!syncState.rosterLocked) {
    actions.append(
      button("Teilnehmerliste sperren", "primary-button", () => request("lock-roster")),
      button("Testspieler hinzufügen", "secondary-button", () => request("seed-test-players")),
      button("Standardverteilung", "secondary-button", confirmStandardDistribution)
    );
  } else {
    actions.append(button("Teilnehmerliste entsperren", "secondary-button", () => request("unlock-roster")));
  }
  content.replaceChildren(teams, actions);
}

async function confirmDeleteParticipant(participant, team, trigger) {
  const confirmed = await confirmAction({
    title: `«${participant.name}» entfernen?`,
    message: `${participant.name} wird aus dem Sync-Up-Team «${team.name}» entfernt und kann sich neu registrieren.`,
    confirmLabel: "Person entfernen",
    cancelLabel: "Behalten"
  });
  if (confirmed) await request("delete-participant", { participantId: participant.id });
  else trigger.disabled = false;
}

async function confirmDeleteSyncTeam(team, memberCount, trigger) {
  const mappedNames = team.quizTeamIndices.map((index) => syncState.teams[index]).join(", ");
  const details = [
    memberCount ? `${memberCount} registrierte ${memberCount === 1 ? "Person wird" : "Personen werden"} entfernt.` : "",
    mappedNames ? `Die Zuordnung von ${mappedNames} wird aufgehoben.` : ""
  ].filter(Boolean).join(" ");
  const confirmed = await confirmAction({
    title: `«${team.name}» löschen?`,
    message: details || "Dieses Sync-Up-Team wird gelöscht.",
    confirmLabel: "Team löschen",
    cancelLabel: "Behalten"
  });
  if (confirmed) await request("delete-sync-team", { syncTeamId: team.id });
  else trigger.disabled = false;
}

async function confirmStandardDistribution(trigger) {
  let confirmed = true;
  if (syncState.syncTeams.length || syncState.participants.length) {
    confirmed = await confirmAction({
      title: "Standardverteilung erstellen?",
      message: "Alle bisherigen Sync-Up-Teams und Registrierungen werden ersetzt. Die Quizpunkte bleiben erhalten.",
      confirmLabel: "Standardverteilung erstellen",
      cancelLabel: "Behalten"
    });
  }
  if (confirmed) await request("standard-distribution");
  else trigger.disabled = false;
}

function renderOverview() {
  statusLine.textContent = "Wählt den nächsten Prompt oder beendet Sync Up.";
  const layout = document.createElement("div");
  layout.className = "sync-overview";
  const prompts = document.createElement("div");
  prompts.className = "sync-question-grid";
  state.config.games.sync.questions.forEach((question) => {
    const complete = syncState.completedQuestionIds.includes(question.id);
    const card = button(question.prompt, `sync-question-card${complete ? " completed" : ""}`, async (trigger) => {
      if (complete) {
        trigger.disabled = false;
        return;
      }
      await request("prepare", {
        question: {
          ...question,
          timeLimitSeconds: state.config.games.sync.timeLimitSeconds,
          pointsPerSync: state.config.games.sync.pointsPerSync
        }
      });
    });
    if (complete) {
      card.title = "Bereits abgeschlossen · mit Rechtsklick erneut freischalten";
      card.setAttribute("aria-disabled", "true");
      card.setAttribute("aria-label", `${question.prompt}, abgeschlossen. Mit Rechtsklick erneut freischalten.`);
      card.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        try {
          syncState = await request("reopen-question", { questionId: question.id });
          renderOverview();
          statusLine.textContent = "Der Prompt kann erneut gespielt werden.";
          await publishSync();
        } catch (error) {
          console.error(error);
          statusLine.textContent = error.message;
        }
      });
    }
    prompts.append(card);
  });
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  actions.append(
    button("Spiel zurücksetzen", "danger-button", confirmReset)
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
  const timer = timerControl(round.timeLimitSeconds);
  const actions = document.createElement("div");
  actions.className = "sync-actions";
  actions.append(
    button("Timer starten", "primary-button", () => request("start", {
      timeLimitSeconds: timerSeconds(timer.input)
    })),
    button("Abbrechen", "danger-button", confirmCancel)
  );
  panel.append(prompt, timer.label, actions);
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
    button("Runde abbrechen", "danger-button", confirmCancel)
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
    title.textContent = syncState.syncTeams.find((team) => team.id === result.syncTeamId)?.name || "?";
    const points = document.createElement("strong");
    points.className = "sync-result-points";
    points.textContent = `+${formatInteger(result.points)}`;
    card.dataset.syncTeamId = result.syncTeamId;
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
      button("Frage abbrechen", "danger-button", confirmCancel)
    );
  }
  content.replaceChildren(heading, resultTeams(round), actions);
}

async function confirmCancel(trigger) {
  const confirmed = await confirmAction({
    title: "Diese Frage abbrechen?",
    message: "Alle Antworten und Ergebnisse dieser Frage werden verworfen.",
    confirmLabel: "Frage abbrechen",
    cancelLabel: "Frage fortsetzen"
  });
  if (confirmed) await request("cancel");
  else trigger.disabled = false;
}

async function confirmReset(trigger) {
  const confirmed = await confirmAction({
    title: "Sync Up zurücksetzen?",
    message: "Alle Teilnehmer, Antworten und Sync-Punkte werden gelöscht.",
    confirmLabel: "Spiel zurücksetzen",
    cancelLabel: "Behalten"
  });
  if (confirmed) await request("reset-game");
  else trigger.disabled = false;
}

async function distribute() {
  const award = await request("awards");
  if (applyAward(award.awardId, award.awards, "sync")) {
    const round = syncState.round;
    recordAnalyticsEvent({
      id: `sync:${award.awardId}`, type: "sync-round", questionId: round.questionId,
      prompt: round.prompt,
      teams: round.results.flatMap((result) => {
        const mapping = syncState.syncTeams.find(({ id }) => id === result.syncTeamId);
        return (mapping?.quizTeamIndices || []).map((teamIndex) => ({
          teamIndex, syncTeamId: result.syncTeamId, synced: result.synced, points: result.points
        }));
      })
    });
    renderScoreboard();
  }
  await saveState();
  await request("confirm-distribution");
  await publishSync();
}

function render(snapshot) {
  syncState = snapshot;
  rulesButton.hidden = Boolean(syncState.round);
  root.querySelector(".sync-heading").hidden = false;
  if (syncState.round?.phase === "prepared") renderPrepared(syncState.round);
  else if (syncState.round?.phase === "active") renderActive(syncState.round);
  else if (["results", "distributed"].includes(syncState.round?.phase)) renderResults(syncState.round);
  else if (!syncState.rosterLocked) renderLobby();
  else renderOverview();
}

export async function mount(element, { showRules } = {}) {
  root = element;
  content = root.querySelector("#sync-content");
  statusLine = root.querySelector("#sync-status");
  rulesButton = root.querySelector("#sync-rules-button");
  rulesButton.addEventListener("click", () => showRules().catch((error) => { statusLine.textContent = error.message; }));
  await request("configure", {
    teams: state.teams.map((team) => team.name),
    questionIds: state.config.games.sync.questions.map((question) => question.id)
  });
  await publishSync();
  render(await hostFetch("/api/sync/state", { cache: "no-store" }).then((response) => response.json()));
  events = subscribeHostState("sync", (snapshot) => {
    render(snapshot);
  });
  ticker = setInterval(() => {
    const timer = content.querySelector(".sync-host-timer[data-deadline]");
    if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
  }, 100);
  return () => {
    events?.();
    clearInterval(ticker);
  };
}
