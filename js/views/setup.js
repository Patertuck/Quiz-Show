import qrcode from "../../assets/vendor/qrcode.js";
import { state, startRuntime, resumeRuntime, saveState, deleteSavedState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";
import { publishTeamLobby } from "../presentation-host.js";
import { hostFetch } from "../slot-api.js";
import { confirmAction } from "../confirm-dialog.js";
import { subscribeHostState } from "../host/live-state.js";

async function post(path, payload) {
  const response = await hostFetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export async function mount(root, { navigate }) {
  const title = root.querySelector("#setup-title");
  const list = root.querySelector("#team-editors");
  const count = root.querySelector("#team-count");
  const message = root.querySelector("#setup-message");
  const addButton = root.querySelector("#add-team-button");
  const startButton = root.querySelector("#start-button");
  const resumeButton = root.querySelector("#resume-button");
  const newButton = root.querySelector("#new-game-button");
  const saved = state.savedState;
  const compatible = saved && !saved.invalid;
  let lobby;
  let events;
  let busy = false;
  const nameDrafts = new Map();
  const nameErrors = new Map();
  const pendingNameSaves = new Map();

  title.textContent = state.config.title;
  const seed = (compatible ? saved.teams : state.config.teams).map((team, index) => ({
    name: team.name,
    currentScore: Number.isInteger(team.score) ? team.score : (team.startingScore || 0),
    startingScore: state.config.teams[index]?.startingScore ?? 0
  }));
  lobby = await post("/api/team-lobby/initialize", {
    teams: seed, force: !state.gameStarted
  });
  const editingActiveGame = state.gameStarted && lobby.phase === "locked";

  const infoResponse = await hostFetch("/api/buzzer/info", { cache: "no-store" });
  if (!infoResponse.ok) throw new Error(`HTTP ${infoResponse.status}`);
  const joinInfo = await infoResponse.json();
  const joinLink = root.querySelector("#setup-join-url");
  joinLink.href = joinInfo.joinUrl;
  joinLink.textContent = joinInfo.joinUrl;
  const code = qrcode(0, "M");
  code.addData(joinInfo.joinUrl);
  code.make();
  root.querySelector("#setup-qr").innerHTML = code.createSvgTag({
    cellSize: 8, margin: 12, scalable: true, title: "QR-Code für Quizspieler"
  });
  if (!editingActiveGame) await publishTeamLobby(joinInfo.joinUrl);

  async function control(action, extra = {}) {
    message.textContent = "";
    try { lobby = await post("/api/team-lobby/control", { action, ...extra }); render(); }
    catch (error) { message.textContent = error.message; throw error; }
  }

  async function saveTeamName(teamId) {
    if (pendingNameSaves.has(teamId)) await pendingNameSaves.get(teamId);
    const team = lobby.teams.find((item) => item.id === teamId);
    const draft = nameDrafts.get(teamId);
    if (!team || draft === undefined) return;
    if (draft.trim().replace(/\s+/g, " ") === team.name) {
      nameDrafts.delete(teamId);
      nameErrors.delete(teamId);
      render();
      return;
    }

    nameErrors.delete(teamId);
    const submitted = draft;
    const request = post("/api/team-lobby/control", { action: "rename", teamId, name: submitted });
    pendingNameSaves.set(teamId, request);
    render();
    try {
      lobby = await request;
      if (nameDrafts.get(teamId) === submitted) nameDrafts.delete(teamId);
      nameErrors.delete(teamId);
    } catch (error) {
      nameErrors.set(teamId, error.message);
      message.textContent = error.message;
      throw error;
    } finally {
      pendingNameSaves.delete(teamId);
      render();
    }
  }

  async function flushTeamNames() {
    for (const teamId of [...nameDrafts.keys()]) await saveTeamName(teamId);
    await Promise.all(pendingNameSaves.values());
  }

  function render() {
    const focused = document.activeElement?.classList.contains("team-name-editor")
      ? { id: document.activeElement.dataset.teamId, value: document.activeElement.value } : null;
    count.textContent = `${lobby.teams.length} von ${lobby.maxTeams}`;
    list.replaceChildren();
    lobby.teams.forEach((team) => {
      const item = document.createElement("li");
      const input = document.createElement("input");
      input.className = "team-name-editor";
      input.dataset.teamId = team.id;
      input.maxLength = 40;
      input.disabled = lobby.phase !== "open";
      input.value = focused?.id === team.id ? focused.value : (nameDrafts.get(team.id) ?? team.name);
      input.setAttribute("aria-label", `Name von ${team.name}`);
      input.setAttribute("aria-invalid", String(nameErrors.has(team.id)));
      input.addEventListener("input", () => {
        nameDrafts.set(team.id, input.value);
        nameErrors.delete(team.id);
      });
      input.addEventListener("blur", () => saveTeamName(team.id).catch(() => undefined));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          saveTeamName(team.id).catch(() => undefined);
        } else if (event.key === "Escape") {
          event.preventDefault();
          nameDrafts.delete(team.id);
          nameErrors.delete(team.id);
          input.value = team.name;
          input.blur();
        }
      });
      const saveStatus = document.createElement("span");
      saveStatus.className = "team-name-status";
      if (pendingNameSaves.has(team.id)) {
        saveStatus.textContent = "Wird gespeichert…";
      } else if (nameErrors.has(team.id)) {
        saveStatus.textContent = "Nicht gespeichert";
        saveStatus.classList.add("error");
        saveStatus.title = nameErrors.get(team.id);
      } else if (nameDrafts.has(team.id)) {
        saveStatus.textContent = "Ungespeichert";
      } else {
        saveStatus.textContent = "Gespeichert";
      }
      const members = document.createElement("span");
      members.className = `team-member-count${team.memberCount ? " connected" : ""}`;
      members.textContent = team.memberCount === 0
        ? "Keine Handys"
        : `${team.memberCount} ${team.memberCount === 1 ? "Handy" : "Handys"} verbunden`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-team-button";
      remove.textContent = "×";
      remove.disabled = lobby.phase !== "open";
      remove.setAttribute("aria-label", `${team.name} entfernen`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await flushTeamNames();
          await control("remove", { teamId: team.id });
          nameDrafts.delete(team.id);
          nameErrors.delete(team.id);
        } catch {
          remove.disabled = false;
        }
      });
      item.append(input, saveStatus, members, remove);
      list.append(item);
    });
    if (focused) {
      const input = list.querySelector(`[data-team-id="${CSS.escape(focused.id)}"]`);
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(focused.value.length, focused.value.length);
    }
    addButton.disabled = lobby.phase !== "open" || lobby.teams.length >= lobby.maxTeams;
    startButton.disabled = busy || lobby.phase !== "open" || !lobby.teams.length;
    resumeButton.disabled = editingActiveGame ? false : startButton.disabled;
    newButton.disabled = busy || !lobby.teams.length || (!editingActiveGame && lobby.phase !== "open");
  }

  addButton.addEventListener("click", async () => {
    try {
      await flushTeamNames();
      const names = new Set(lobby.teams.map((team) => team.name.toLocaleLowerCase()));
      let number = 1;
      while (names.has(`team ${number}`)) number += 1;
      await control("add", { name: `Team ${number}` });
      const input = list.lastElementChild?.querySelector("input");
      input?.focus(); input?.select();
    } catch { /* The field-level or lobby message already explains the error. */ }
  });

  async function begin(mode) {
    if (busy) return;
    busy = true;
    render();
    try {
      if (mode === "new" && lobby.phase === "locked") {
        lobby = await post("/api/team-lobby/control", { action: "unlock" });
      }
      await flushTeamNames();
      lobby = await post("/api/team-lobby/control", { action: "lock" });
      const teams = lobby.teams.map((team) => ({
        name: team.name, score: mode === "resume" ? team.currentScore : team.startingScore
      }));
      if (mode === "resume") resumeRuntime(teams);
      else {
        if (saved) await deleteSavedState();
        startRuntime(teams);
      }
      renderScoreboard();
      await saveState();
      navigate("hub");
    } catch (error) {
      message.textContent = error.message;
      await post("/api/team-lobby/control", { action: "unlock" }).then((value) => { lobby = value; }).catch(() => undefined);
      busy = false;
      render();
    }
  }

  startButton.addEventListener("click", () => begin("new"));
  resumeButton.addEventListener("click", () => editingActiveGame ? navigate("hub") : begin("resume"));
  newButton.addEventListener("click", async () => {
    const confirmed = await confirmAction({
      title: "Neues Spiel starten?",
      message: "Der aktuelle Spielstand und alle bisherigen Runden werden gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.",
      confirmLabel: "Neues Spiel starten",
      cancelLabel: "Abbrechen"
    });
    if (confirmed) await begin("new");
  });
  if (editingActiveGame) {
    startButton.hidden = true;
    resumeButton.hidden = false;
    resumeButton.disabled = false;
    resumeButton.textContent = "Spiel fortsetzen";
    newButton.hidden = false;
    message.textContent = "Während des laufenden Spiels ist die Teamliste gesperrt.";
  } else if (compatible) {
    startButton.hidden = true;
    resumeButton.hidden = false;
    newButton.hidden = false;
    message.textContent = "Gespeichertes Spiel verfügbar: Teams dürfen vor dem Fortsetzen noch bearbeitet werden.";
  } else if (saved) {
    message.textContent = "Der alte Spielstand passt nicht mehr zur Quizkonfiguration; es kann nur ein neues Spiel gestartet werden.";
  }
  render();
  events = subscribeHostState("teamLobby", (snapshot) => { lobby = snapshot; render(); });
  return () => events?.();
}
