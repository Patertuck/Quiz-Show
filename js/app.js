import { state, loadApplicationData, stateSnapshot, resumeRuntime } from "./store.js";
import { initializeScoreboard, renderScoreboard, setScoreboard, updateScoreControls } from "./scoreboard.js";
import * as setup from "./views/setup.js";
import * as hub from "./views/hub.js";
import * as jeopardy from "./games/jeopardy.js";
import * as ordering from "./games/ordering.js";
import * as victory from "./views/victory.js";

const app = document.querySelector("#app");
const scoreboardElement = document.querySelector("#scoreboard");
initializeScoreboard(scoreboardElement);

const routes = {
  setup: { template: "views/setup.html", controller: setup, scoreboard: "hidden", requiresGame: false },
  hub: { template: "views/hub.html", controller: hub, scoreboard: "standings", requiresGame: true },
  jeopardy: { template: "views/jeopardy.html", controller: jeopardy, scoreboard: "game", requiresGame: true },
  ordering: { template: "views/ordering.html", controller: ordering, scoreboard: "standings", requiresGame: true },
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
      if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
      return response.text();
    }));
  }
  return templateCache.get(path);
}

function renderError(error) {
  setScoreboard("hidden");
  app.innerHTML = `<section class="status-screen"><div class="panel"><h1>Quiz error</h1><p class="error-message"></p></div></section>`;
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
    setScoreboard(route.scoreboard);
    document.body.classList.toggle("app-active", name !== "setup");
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
  if (requestedRoute !== "setup" && compatibleSave) {
    resumeRuntime(saved.teams);
    renderScoreboard();
  }
  if (!location.hash) navigate("setup");
  else await renderRoute();
} catch (error) {
  console.error(error);
  renderError(error);
}
