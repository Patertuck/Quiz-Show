import { state, loadApplicationData, stateSnapshot, resumeRuntime, saveState, setScoreHistoryGame } from "./store.js";
import { initializeScoreboard, renderScoreboard, setScoreboard, updateScoreControls } from "./scoreboard.js";
import { initializeHostControls } from "./host-controls.js";
import * as setup from "./views/setup.js";
import * as intro from "./views/intro.js";
import * as warmup from "./views/warmup.js";
import * as hub from "./views/hub.js";
import * as jeopardy from "./games/jeopardy.js";
import * as ordering from "./games/ordering.js";
import * as listing from "./games/listing.js";
import * as sync from "./games/sync.js";
import * as victory from "./views/victory.js";

const app = document.querySelector("#app");
const scoreboardElement = document.querySelector("#scoreboard");
const hostControls = document.querySelector("#host-controls");
initializeScoreboard(scoreboardElement);
initializeHostControls({ navigate });

const routes = {
  setup: { template: "views/setup.html", controller: setup, scoreboard: "hidden", requiresGame: false, hostControls: "hidden" },
  intro: { template: "views/intro.html", controller: intro, scoreboard: "hidden", requiresGame: false, hostControls: "audio" },
  warmup: { template: "views/warmup.html", controller: warmup, scoreboard: "hidden", requiresGame: true, hostControls: "audio" },
  hub: { template: "views/hub.html", controller: hub, scoreboard: "standings", requiresGame: true },
  jeopardy: { template: "views/jeopardy.html", controller: jeopardy, scoreboard: "game", requiresGame: true },
  ordering: { template: "views/ordering.html", controller: ordering, scoreboard: "standings", requiresGame: true },
  listing: { template: "views/listing.html", controller: listing, scoreboard: "standings", requiresGame: true },
  sync: { template: "views/sync.html", controller: sync, scoreboard: "standings", requiresGame: true },
  victory: { template: "views/victory.html", controller: victory, scoreboard: "hidden", requiresGame: true }
};

const templateCache = new Map();
let cleanup;
let navigationId = 0;

function routeName() {
  return location.hash.replace(/^#\/?/, "").split("/")[0] || "setup";
}

export function navigate(name) {
  const hash = `#/${name}`;
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

async function templateFor(path) {
  if (!templateCache.has(path)) {
    templateCache.set(path, fetch(path, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`${path} konnte nicht geladen werden (HTTP ${response.status}).`);
      return response.text();
    }));
  }
  return templateCache.get(path);
}

function renderError(error) {
  setScoreboard("hidden");
  hostControls.hidden = true;
  app.innerHTML = `<section class="status-screen"><div class="panel"><h1>Quizfehler</h1><p class="error-message"></p></div></section>`;
  app.querySelector(".error-message").textContent = error.message;
}

async function renderRoute() {
  const thisNavigation = ++navigationId;
  let name = routeName();
  let route = routes[name];
  if (!route || (route.requiresGame && !state.gameStarted)) {
    navigate(state.gameStarted ? "hub" : "setup");
    return;
  }
  try {
    if (cleanup) {
      cleanup();
      cleanup = undefined;
    }
    if (name !== "jeopardy") {
      state.activeValue = 0;
      updateScoreControls();
    }
    if (["jeopardy", "ordering", "listing", "sync"].includes(name) && setScoreHistoryGame(name)) {
      saveState().catch(() => undefined);
    }
    setScoreboard(route.scoreboard);
    document.body.classList.toggle("app-active", name !== "setup");
    hostControls.hidden = route.hostControls === "hidden";
    hostControls.classList.toggle("audio-only", route.hostControls === "audio");
    const template = await templateFor(route.template);
    if (thisNavigation !== navigationId) return;
    app.innerHTML = template;
    const result = await route.controller.mount(app, { navigate });
    if (thisNavigation !== navigationId) {
      if (typeof result === "function") result();
      return;
    }
    cleanup = typeof result === "function" ? result : undefined;
  } catch (error) {
    console.error(error);
    renderError(error);
  }
}

window.addEventListener("hashchange", renderRoute);
window.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "v"
      || !state.gameStarted || ["setup", "victory"].includes(routeName())) return;
  event.preventDefault();
  navigate("victory");
});
window.addEventListener("pagehide", () => {
  if (!state.gameStarted) return;
  fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stateSnapshot()),
    keepalive: true
  }).catch(() => undefined);
});

try {
  await loadApplicationData();
  const requestedRoute = routeName();
  const saved = state.savedState;
  const compatibleSave = saved && !saved.invalid && saved.configFingerprint === state.configFingerprint;
  if (!["setup", "intro"].includes(requestedRoute) && compatibleSave) {
    resumeRuntime(saved.teams);
    renderScoreboard();
  }
  if (!location.hash) navigate("intro");
  else await renderRoute();
} catch (error) {
  console.error(error);
  renderError(error);
}
