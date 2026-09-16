import { state, loadApplicationData, loadQuizLibrary, stateSnapshot, resumeRuntime, saveState, setScoreHistoryGame } from "./store.js";
import { initializeScoreboard, renderScoreboard, setScoreboard, updateScoreControls } from "./scoreboard.js";
import { initializeHostControls } from "./host-controls.js";
import * as setup from "./views/setup.js";
import * as master from "./views/master.js";
import * as start from "./views/start.js";
import * as hub from "./views/hub.js";
import * as jeopardy from "./games/jeopardy.js";
import * as ordering from "./games/ordering.js";
import * as listing from "./games/listing.js";
import * as sync from "./games/sync.js";
import * as victory from "./views/victory.js";
import { GAME_CATALOG, hasConfiguredGame } from "./game-catalog.js";
import { hostFetch, setActiveInstanceName } from "./slot-api.js";

const app = document.querySelector("#app");
const scoreboardElement = document.querySelector("#scoreboard");
const hostControls = document.querySelector("#host-controls");
initializeScoreboard(scoreboardElement);
initializeHostControls({ navigate, requestEndGame });

const gameControllers = { jeopardy, ordering, listing, sync };
const gameRoutes = Object.fromEntries(GAME_CATALOG.map((game) => [game.id, {
  template: game.template,
  controller: gameControllers[game.id],
  scoreboard: game.scoreboard,
  requiresGame: true,
  gameId: game.id
}]));

const routes = {
  master: { template: "views/master.html", controller: master, scoreboard: "hidden", requiresGame: false, requiresConfig: false, hostControls: "hidden" },
  start: { template: "views/start.html", controller: start, scoreboard: "hidden", requiresGame: false, hostControls: "hidden" },
  setup: { template: "views/setup.html", controller: setup, scoreboard: "hidden", requiresGame: false, hostControls: "hidden" },
  hub: { template: "views/hub.html", controller: hub, scoreboard: "standings", requiresGame: true },
  ...gameRoutes,
  victory: { template: "views/victory.html", controller: victory, scoreboard: "hidden", requiresGame: true }
};

const templateCache = new Map();
let cleanup;
let navigationId = 0;

function routeLocation() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const name = parts[0] || "intro";
  return { name, canonical: Boolean(parts[0]) && name !== "start" };
}

function routeName() {
  const requested = routeLocation().name;
  if (requested === "intro") return "start";
  return requested;
}

export function navigate(name) {
  const visibleName = name === "start" ? "intro" : name;
  const hasRouteAccess = Boolean(state.library?.activeInstanceName) || visibleName === "master";
  const hash = hasRouteAccess ? `#/${visibleName}` : "#/master";
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

function requestEndGame() {
  if (window.confirm("Spiel wirklich beenden und den Endstand anzeigen?")) navigate("victory");
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
  if (route?.requiresConfig !== false && !state.config) {
    navigate("master");
    return;
  }
  if (!route || (route.requiresGame && !state.gameStarted)) {
    navigate(state.gameStarted ? "hub" : "setup");
    return;
  }
  if (route.gameId && !hasConfiguredGame(state.config, route.gameId)) {
    navigate("hub");
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
    if (route.gameId && setScoreHistoryGame(route.gameId)) {
      saveState().catch(() => undefined);
    }
    setScoreboard(route.scoreboard);
    document.body.classList.toggle("app-active", !["setup", "master"].includes(name));
    hostControls.hidden = route.hostControls === "hidden";
    hostControls.classList.toggle("audio-only", route.hostControls === "audio");
    hostControls.classList.toggle("on-victory", name === "victory");
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
  requestEndGame();
});
window.addEventListener("pagehide", () => {
  if (!state.gameStarted) return;
  hostFetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stateSnapshot()),
    keepalive: true
  }).catch(() => undefined);
});

try {
  let library = await loadQuizLibrary();
  const requestedLocation = routeLocation();
  const requestedRoute = routeName();
  setActiveInstanceName(library.activeInstanceName);
  if (requestedRoute === "master" || !library.activeInstanceName || !library.activeConfigUrl) {
    state.config = null;
    if (requestedRoute !== "master") navigate("master");
    else await renderRoute();
  } else {
    let loaded = true;
    try {
      await loadApplicationData(library.activeConfigUrl);
    } catch (error) {
      console.error(error);
      state.config = null;
      state.library.configError = error.message;
      loaded = false;
      navigate("master");
    }
    if (loaded) {
      const saved = state.savedState;
      const compatibleSave = saved && !saved.invalid;
      if (!["setup", "start"].includes(requestedRoute) && compatibleSave) {
        resumeRuntime(saved.teams);
        renderScoreboard();
      }
      if (!requestedLocation.canonical) navigate(requestedRoute);
      else await renderRoute();
    }
  }
} catch (error) {
  console.error(error);
  renderError(error);
}
