import { loadQuizConfig, loadQuizLibrary, saveState, state } from "../store.js";
import { publishStandby } from "../presentation-host.js";

async function control(action, extra = {}) {
  const response = await fetch("/api/quiz-library/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  state.library = payload;
  return payload;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unbekannt" : new Intl.DateTimeFormat("de-CH", {
    dateStyle: "medium", timeStyle: "short"
  }).format(date);
}

function reloadAt(path) {
  window.history.replaceState(null, "", path);
  window.location.reload();
}

export async function mount(root) {
  if (state.gameStarted) await saveState();
  if (state.library?.activeSlotId) await publishStandby();
  const groups = root.querySelector("#master-save-groups");
  const form = root.querySelector("#master-new-form");
  const nameInput = root.querySelector("#master-slot-name");
  const configSelect = root.querySelector("#master-config");
  const errorLine = root.querySelector("#master-new-error");
  const initialError = state.library?.configError;
  let library = await loadQuizLibrary();
  const configs = new Map();
  if (initialError) errorLine.textContent = initialError;

  async function switchSlot(action, payload, destination) {
    const wasStarted = state.gameStarted;
    state.gameStarted = false;
    try {
      await control(action, payload);
      reloadAt(`/#/${destination}`);
    } catch (error) {
      state.gameStarted = wasStarted;
      throw error;
    }
  }

  await Promise.all(library.configurations.map(async (item) => {
    try {
      const config = await loadQuizConfig(item.url);
      configs.set(item.id, { ...item, title: config.title, valid: true });
    } catch (error) {
      configs.set(item.id, { ...item, title: item.id, valid: false, error: error.message });
    }
  }));

  function renderConfigOptions() {
    configSelect.replaceChildren();
    [...configs.values()].sort((a, b) => a.title.localeCompare(b.title, "de-CH")).forEach((config) => {
      const option = document.createElement("option");
      option.value = config.id;
      option.textContent = config.valid ? config.title : `${config.title} (ungültig)`;
      option.disabled = !config.valid;
      configSelect.append(option);
    });
    const available = [...configs.values()].some(({ valid }) => valid);
    form.querySelector("button").disabled = !available;
    if (!available) errorLine.textContent = "Legt eine gültige JSON-Konfiguration im Ordner quizzes ab.";
  }

  function actionButton(text, className, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await action(); }
      catch (error) { errorLine.textContent = error.message; }
      finally { button.disabled = false; }
    });
    return button;
  }

  function renderSlots() {
    groups.replaceChildren();
    if (!library.slots.length) {
      const empty = document.createElement("p");
      empty.className = "master-empty panel";
      empty.textContent = "Noch keine Spielstände vorhanden.";
      groups.append(empty);
      return;
    }
    const byConfig = new Map();
    library.slots.forEach((slot) => {
      if (!byConfig.has(slot.configId)) byConfig.set(slot.configId, []);
      byConfig.get(slot.configId).push(slot);
    });
    byConfig.forEach((slots, configId) => {
      const section = document.createElement("section");
      section.className = "master-save-group";
      const heading = document.createElement("h3");
      heading.textContent = configs.get(configId)?.title || `${configId} (Konfiguration fehlt)`;
      section.append(heading);
      const grid = document.createElement("div");
      grid.className = "master-save-grid";
      slots.forEach((slot) => {
        const card = document.createElement("article");
        card.className = `master-save-card panel${slot.id === library.activeSlotId ? " active" : ""}`;
        const title = document.createElement("h4"); title.textContent = slot.name;
        const detail = document.createElement("p");
        detail.textContent = `${slot.hasState ? "Spiel begonnen" : "Noch nicht begonnen"} · ${formatTime(slot.updatedAt)}`;
        const actions = document.createElement("div"); actions.className = "master-save-actions";
        actions.append(actionButton("Fortsetzen", "primary-button", async () => {
          await switchSlot("activate", { slotId: slot.id }, slot.hasState ? "hub" : "setup");
        }));
        actions.lastElementChild.disabled = !slot.configAvailable || !configs.get(configId)?.valid;
        actions.append(actionButton("Umbenennen", "secondary-button", async () => {
          const name = window.prompt("Neuer Name des Spielstands", slot.name);
          if (name === null) return;
          library = await control("rename", { slotId: slot.id, name });
          renderSlots();
        }));
        actions.append(actionButton("Löschen", "danger-button", async () => {
          if (!window.confirm(`Spielstand «${slot.name}» wirklich löschen?`)) return;
          const wasActive = slot.id === library.activeSlotId;
          const wasStarted = state.gameStarted;
          if (wasActive) state.gameStarted = false;
          try { library = await control("delete", { slotId: slot.id }); }
          catch (error) { state.gameStarted = wasStarted; throw error; }
          if (wasActive) reloadAt("/#/master");
          else renderSlots();
        }));
        if (!slot.configAvailable) {
          const warning = document.createElement("p");
          warning.className = "master-save-warning";
          warning.textContent = "Die zugehörige Quizkonfiguration fehlt.";
          card.append(title, detail, warning, actions);
        } else card.append(title, detail, actions);
        grid.append(card);
      });
      section.append(grid);
      groups.append(section);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorLine.textContent = "";
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await switchSlot("create", { name: nameInput.value, configId: configSelect.value }, "intro");
    } catch (error) {
      errorLine.textContent = error.message;
      button.disabled = false;
    }
  });

  renderConfigOptions();
  renderSlots();
}
