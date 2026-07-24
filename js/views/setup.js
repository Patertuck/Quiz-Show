import { state, startRuntime, resumeRuntime, saveState, deleteSavedState } from "../store.js";
import { renderScoreboard } from "../scoreboard.js";
import { publishStandby } from "../presentation-host.js";

export function mount(root, { navigate }) {
  publishStandby().catch(() => undefined);
  const title = root.querySelector("#setup-title");
  const list = root.querySelector("#team-editors");
  const message = root.querySelector("#setup-message");
  const startButton = root.querySelector("#start-button");
  const resumeButton = root.querySelector("#resume-button");
  const newButton = root.querySelector("#new-game-button");
  title.textContent = state.config.title;

  const saved = state.savedState;
  const compatible = saved && !saved.invalid && saved.configFingerprint === state.configFingerprint;
  let teams = (compatible ? saved.teams : state.config.teams).map((team) => ({
    name: team.name,
    score: Number.isInteger(team.score) ? team.score : team.startingScore
  }));

  function renderEditors() {
    list.replaceChildren();
    teams.forEach((team, index) => {
      const item = document.createElement("li");
      const input = document.createElement("input");
      input.className = "team-name-editor";
      input.value = team.name;
      input.required = true;
      input.setAttribute("aria-label", `Name für Team ${index + 1}`);
      input.addEventListener("input", () => { teams[index].name = input.value; });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-team-button";
      remove.textContent = "×";
      remove.disabled = teams.length === 1;
      remove.setAttribute("aria-label", `${team.name || `Team ${index + 1}`} entfernen`);
      remove.addEventListener("click", () => { teams.splice(index, 1); renderEditors(); });
      item.append(input, remove);
      list.append(item);
    });
  }

  function validatedTeams() {
    const inputs = Array.from(list.querySelectorAll(".team-name-editor"));
    const names = inputs.map((input) => input.value.trim());
    const empty = names.findIndex((name) => !name);
    if (empty !== -1) {
      window.alert("Jedes Team benötigt einen Namen, bevor das Spiel beginnen kann.");
      inputs[empty].focus();
      return null;
    }
    return teams.map((team, index) => ({ ...team, name: names[index] }));
  }

  root.querySelector("#add-team-button").addEventListener("click", () => {
    const names = new Set(teams.map((team) => team.name.trim().toLowerCase()));
    let number = 1;
    while (names.has(`team ${number}`)) number += 1;
    teams.push({ name: `Team ${number}`, score: 0 });
    renderEditors();
    const inputs = list.querySelectorAll(".team-name-editor");
    inputs[inputs.length - 1].select();
  });

  startButton.addEventListener("click", async () => {
    const selected = validatedTeams();
    if (!selected) return;
    startRuntime(selected);
    renderScoreboard();
    await saveState().catch(() => undefined);
    navigate("hub");
  });

  resumeButton.addEventListener("click", async () => {
    const selected = validatedTeams();
    if (!selected) return;
    resumeRuntime(selected);
    renderScoreboard();
    await saveState().catch(() => undefined);
    navigate("hub");
  });

  newButton.addEventListener("click", async () => {
    const selected = validatedTeams();
    if (!selected || (saved && !window.confirm("Gespeichertes Spiel löschen und neu beginnen? Dies kann nicht rückgängig gemacht werden."))) return;
    try { await deleteSavedState(); }
    catch (error) { window.alert(`Das gespeicherte Spiel konnte nicht gelöscht werden: ${error.message}`); return; }
    const resetTeams = selected.map((team, index) => ({
      name: team.name,
      score: state.config.teams[index]?.startingScore ?? 0
    }));
    startRuntime(resetTeams);
    renderScoreboard();
    await saveState().catch(() => undefined);
    navigate("hub");
  });

  if (!saved) {
    message.textContent = "Kein gespeichertes Spiel gefunden.";
  } else if (!compatible) {
    startButton.hidden = true;
    newButton.hidden = false;
    message.textContent = saved.invalid
      ? `Das gespeicherte Spiel kann nicht fortgesetzt werden: ${saved.error}`
      : "Die Quizkonfiguration wurde geändert. Startet ein neues Spiel, um den inkompatiblen Spielstand zu ersetzen.";
  } else {
    startButton.hidden = true;
    resumeButton.hidden = false;
    newButton.hidden = false;
    const savedTime = new Date(saved.updatedAt);
    message.textContent = Number.isNaN(savedTime.valueOf())
      ? "Ein gespeicherter Spielstand ist verfügbar."
      : `Ein gespeicherter Spielstand vom ${savedTime.toLocaleString("de-CH")} ist verfügbar.`;
  }
  renderEditors();
}
