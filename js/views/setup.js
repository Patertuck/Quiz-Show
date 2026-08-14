import qrcode from "../../assets/vendor/qrcode.js";
import { state, startRuntime, resumeRuntime, saveState, deleteSavedState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";
import { publishTeamLobby } from "../presentation-host.js";

async function post(path, payload) {
  const response = await fetch(path, {
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
  const compatible = saved && !saved.invalid && saved.configFingerprint === state.configFingerprint;
  let lobby;
  let events;
  let busy = false;
  const nameDrafts = new Map();

  title.textContent = state.config.title;
  const seed = (compatible ? saved.teams : state.config.teams).map((team, index) => ({
    name: team.name,
    currentScore: Number.isInteger(team.score) ? team.score : (team.startingScore || 0),
    startingScore: state.config.teams[index]?.startingScore ?? 0
  }));
  lobby = await post("/api/team-lobby/initialize", {
    configFingerprint: state.configFingerprint, teams: seed, force: !state.gameStarted
  });
  const editingActiveGame = state.gameStarted && lobby.phase === "locked";

  const infoResponse = await fetch("/api/buzzer/info", { cache: "no-store" });
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
      input.addEventListener("input", () => nameDrafts.set(team.id, input.value));
      const saveName = document.createElement("button");
      saveName.type = "button";
      saveName.className = "save-team-name-button";
      saveName.textContent = "Speichern";
      saveName.disabled = lobby.phase !== "open";
      saveName.addEventListener("click", () => control("rename", { teamId: team.id, name: input.value })
        .then(() => { nameDrafts.delete(team.id); render(); })
        .catch(() => { nameDrafts.delete(team.id); input.value = team.name; }));
      const members = document.createElement("span");
      members.className = "team-member-count";
      members.textContent = `${team.memberCount} ${team.memberCount === 1 ? "Handy" : "Handys"}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-team-button";
      remove.textContent = "×";
      remove.disabled = lobby.phase !== "open";
      remove.setAttribute("aria-label", `${team.name} entfernen`);
      remove.addEventListener("click", () => control("remove", { teamId: team.id }).catch(() => undefined));
      item.append(input, saveName, members, remove);
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
    newButton.disabled = startButton.disabled;
  }

  addButton.addEventListener("click", () => {
    const names = new Set(lobby.teams.map((team) => team.name.toLocaleLowerCase()));
    let number = 1;
    while (names.has(`team ${number}`)) number += 1;
    control("add", { name: `Team ${number}` }).then(() => {
      const input = list.lastElementChild?.querySelector("input");
      input?.focus(); input?.select();
    }).catch(() => undefined);
  });

  async function begin(mode) {
    if (busy) return;
    busy = true;
    render();
    try {
      for (const input of list.querySelectorAll(".team-name-editor")) {
        const team = lobby.teams.find((item) => item.id === input.dataset.teamId);
        if (team && input.value.trim() !== team.name) {
          lobby = await post("/api/team-lobby/control", {
            action: "rename", teamId: team.id, name: input.value
          });
          nameDrafts.delete(team.id);
        }
      }
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
      navigate(mode === "new" ? "warmup" : "hub");
    } catch (error) {
      message.textContent = error.message;
      await post("/api/team-lobby/control", { action: "unlock" }).then((value) => { lobby = value; }).catch(() => undefined);
      busy = false;
      render();
    }
  }

  startButton.addEventListener("click", () => begin("new"));
  resumeButton.addEventListener("click", () => editingActiveGame ? navigate("hub") : begin("resume"));
  newButton.addEventListener("click", () => begin("new"));
  if (editingActiveGame) {
    startButton.hidden = true;
    resumeButton.hidden = false;
    resumeButton.disabled = false;
    resumeButton.textContent = "Zurück zur Spielauswahl";
    newButton.hidden = true;
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
  events = new EventSource("/api/team-lobby/events");
  events.addEventListener("state", (event) => { lobby = JSON.parse(event.data); render(); });
  return () => events?.close();
}
