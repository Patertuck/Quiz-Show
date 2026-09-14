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
  if (state.library?.activeInstanceName) await publishStandby();
  const groups = root.querySelector("#master-save-groups");
  const form = root.querySelector("#master-new-form");
  const nameInput = root.querySelector("#master-slot-name");
  const configSelect = root.querySelector("#master-config");
  const errorLine = root.querySelector("#master-new-error");
  const initialError = state.library?.configError;
  let library = await loadQuizLibrary();
  const variations = new Map();
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

  await Promise.all(library.variations.map(async (item) => {
    try {
      const config = await loadQuizConfig(item.url);
      variations.set(item.id, { ...item, title: config.title, valid: true });
    } catch (error) {
      variations.set(item.id, { ...item, title: item.id, valid: false, error: error.message });
    }
  }));

  function renderConfigOptions() {
    configSelect.replaceChildren();
    [...variations.values()].sort((a, b) => a.title.localeCompare(b.title, "de-CH")).forEach((config) => {
      const option = document.createElement("option");
      option.value = config.id;
      option.textContent = config.valid ? config.title : `${config.title} (ungültig)`;
      option.disabled = !config.valid;
      configSelect.append(option);
    });
    const available = [...variations.values()].some(({ valid }) => valid);
    form.querySelector("button").disabled = !available;
    if (!available) errorLine.textContent = "Legt eine gültige Quiz-Variante unter quiz-data/variations ab.";
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
    if (!library.instances.length) {
      const empty = document.createElement("p");
      empty.className = "master-empty panel";
      empty.textContent = "Noch keine Quiz-Instanzen vorhanden.";
      groups.append(empty);
      return;
    }
    const byConfig = new Map();
    library.instances.forEach((instance) => {
      if (!byConfig.has(instance.variationId)) byConfig.set(instance.variationId, []);
      byConfig.get(instance.variationId).push(instance);
    });
    byConfig.forEach((instances, variationId) => {
      const section = document.createElement("section");
      section.className = "master-save-group";
      const heading = document.createElement("h3");
      heading.textContent = variations.get(variationId)?.title || `${variationId} (Variante fehlt)`;
      section.append(heading);
      const grid = document.createElement("div");
      grid.className = "master-save-grid";
      instances.forEach((instance) => {
        const card = document.createElement("article");
        card.className = `master-save-card panel${instance.name === library.activeInstanceName ? " active" : ""}`;
        const title = document.createElement("h4"); title.textContent = instance.name;
        const detail = document.createElement("p");
        const status = instance.hasState ? "Spiel begonnen" : (instance.hasResults ? "Nur historische Ergebnisse" : "Noch nicht begonnen");
        detail.textContent = `${status}${instance.hasResults ? " · Ergebnisse vorhanden" : ""} · ${formatTime(instance.updatedAt)}`;
        const actions = document.createElement("div"); actions.className = "master-save-actions";
        actions.append(actionButton("Fortsetzen", "primary-button", async () => {
          await switchSlot("activate", { name: instance.name }, instance.hasState ? "hub" : "setup");
        }));
        actions.lastElementChild.disabled = !instance.variationAvailable || !variations.get(variationId)?.valid
          || (!instance.hasState && instance.hasResults);
        actions.append(actionButton("Umbenennen", "secondary-button", async () => {
          const name = window.prompt("Neuer Instanzname (Kleinbuchstaben, Zahlen und Bindestriche)", instance.name);
          if (name === null) return;
          library = await control("rename", { name: instance.name, newName: name });
          renderSlots();
        }));
        actions.append(actionButton("Löschen", "danger-button", async () => {
          const resultWarning = instance.hasResults ? " Alle gespeicherten Ergebnisse gehen ebenfalls verloren." : "";
          if (!window.confirm(`Quiz-Instanz «${instance.name}» wirklich löschen?${resultWarning}`)) return;
          const wasActive = instance.name === library.activeInstanceName;
          const wasStarted = state.gameStarted;
          if (wasActive) state.gameStarted = false;
          try { library = await control("delete", { name: instance.name }); }
          catch (error) { state.gameStarted = wasStarted; throw error; }
          if (wasActive) reloadAt("/#/master");
          else renderSlots();
        }));
        if (!instance.variationAvailable) {
          const warning = document.createElement("p");
          warning.className = "master-save-warning";
          warning.textContent = "Die zugehörige Quiz-Variante fehlt.";
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
      await switchSlot("create", { name: nameInput.value, variationId: configSelect.value }, "intro");
    } catch (error) {
      errorLine.textContent = error.message;
      button.disabled = false;
    }
  });

  renderConfigOptions();
  renderSlots();
}
