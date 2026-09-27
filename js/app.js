import { state, loadApplicationData, loadQuizLibrary, stateSnapshot, resumeRuntime, saveState, setScoreHistoryGame, hasShownGameRules, markGameRulesShown } from "./store.js";
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
import { hasConfiguredGame } from "./game-catalog.js";
import { hostFetch, setActiveInstanceName } from "./slot-api.js";
import { buildGameRules, renderGameRules } from "./game-rules.js";
import { createHostRoutes } from "./host/routes.js";
import { loadTemplate } from "./host/templates.js";
import { publishManualScoreAdjustment, publishRulesExample } from "./presentation-host.js";

const app = document.querySelector("#app");
const scoreboardElement = document.querySelector("#scoreboard");
const hostControls = document.querySelector("#host-controls");
initializeScoreboard(scoreboardElement);
initializeHostControls({ navigate, requestEndGame });
window.addEventListener("quiz-score-changed", (event) => {
  if (event.detail?.source !== "manual") return;
  publishManualScoreAdjustment(event.detail).catch((error) => {
    console.error("Could not show the manual score adjustment on the audience display:", error);
  });
});

const routes = createHostRoutes({
  setup, master, start, hub, victory,
  games: { jeopardy, ordering, listing, sync }
});
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

function renderError(error) {
  setScoreboard("hidden");
  hostControls.hidden = true;
  app.innerHTML = `<section class="status-screen"><div class="panel"><h1>Quizfehler</h1><p class="error-message"></p></div></section>`;
  app.querySelector(".error-message").textContent = error.message;
}

async function showGameRules(gameId, automatic = false) {
  ++navigationId;
  if (cleanup) {
    cleanup();
    cleanup = undefined;
  }
  setScoreboard("hidden");
  const model = buildGameRules(gameId, state.config);
  app.replaceChildren(renderGameRules(model, {
    actionLabel: automatic ? "Spiel starten" : "Zurück zum Spiel",
    onBack: () => navigate("hub"),
    onShowExample: () => publishRulesExample(model.graphic),
    onAction: async (trigger) => {
      trigger.disabled = true;
      const wasShown = hasShownGameRules(gameId);
      try {
        if (automatic && !wasShown) {
          markGameRulesShown(gameId);
          await saveState();
        }
        await renderRoute();
      } catch (error) {
        if (automatic && !wasShown) state.shownRuleGameIds.delete(gameId);
        window.alert(`Die Spielregeln konnten nicht bestätigt werden: ${error.message}`);
        trigger.disabled = false;
      }
    }
  }));
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
    if (route.gameId && !hasShownGameRules(route.gameId)) {
      await showGameRules(route.gameId, true);
      return;
    }
    const template = await loadTemplate(route.template);
    if (thisNavigation !== navigationId) return;
    app.innerHTML = template;
    const result = await route.controller.mount(app, {
      navigate,
      showRules: () => showGameRules(route.gameId, false)
    });
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
