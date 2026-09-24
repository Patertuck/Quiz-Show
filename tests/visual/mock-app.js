import {
  basePresentation, buzzer, config, liveSnapshot, listingBase, logos, orderingBase,
  syncLobby, teamLobby, teams
} from "./fixtures.js";

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

export async function mockLiveSocket(page, snapshot) {
  let connectedSocket = null;
  await page.routeWebSocket("**/ws/live**", (socket) => {
    connectedSocket = socket;
    socket.send(JSON.stringify({ type: "snapshot", data: snapshot }));
    socket.onMessage((message) => {
      try {
        if (JSON.parse(String(message)).type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      } catch { /* A malformed client message should not affect a visual fixture. */ }
    });
  });
  return {
    send(nextSnapshot) {
      if (!connectedSocket) throw new Error("The mocked live socket is not connected.");
      connectedSocket.send(JSON.stringify({ type: "snapshot", data: nextSnapshot }));
    }
  };
}

export async function mockHost(page, { ordering = orderingBase, listing = listingBase, sync = syncLobby,
  activeQuestion = null, lobby = teamLobby, buzzer: buzzerState = buzzer, hostTeams = teams,
  quizConfig = config } = {}) {
  hostTeams = hostTeams.map((team, index) => ({ ...team, color: team.color || teamLobby.colorPalette[index].id }));
  const saved = {
    version: 6, updatedAt: "2026-01-01T12:00:00Z", revision: 5, gameStarted: true,
    teams: hostTeams, usedTiles: ["5:4"], activeQuestion, appliedAwards: [],
    scoreHistory: [
      { scores: hostTeams.map(() => 0), game: null },
      { scores: hostTeams.map(({ score }) => score), game: "jeopardy" }
    ],
    scoreHistoryGame: "jeopardy", shownRuleGameIds: ["jeopardy", "ordering", "listing", "sync"]
  };
  const library = {
    activeInstanceName: "visual-tests", activeConfigUrl: "/visual-config.json", configError: null,
    variations: [{ id: "visual", url: "/visual-config.json" }],
    instances: Array.from({ length: 5 }, (_, index) => ({
      name: `responsive-quiz-${index + 1}`, variationId: "visual", variationAvailable: true,
      hasState: true, hasResults: index % 2 === 0, updatedAt: `2026-01-0${index + 1}T12:00:00Z`
    }))
  };
  const snapshot = liveSnapshot({ ...basePresentation, teams: hostTeams, screen: "hub", games: Object.keys(config.games), highlightedGame: null }, {
    ordering, listing, sync, teamLobby: lobby, buzzer: buzzerState
  });
  const live = await mockLiveSocket(page, snapshot);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/visual-config.json") return route.fulfill(json(quizConfig));
    if (path === "/api/quiz-library") return route.fulfill(json(library));
    if (path === "/api/quiz-library/control") return route.fulfill(json(library));
    if (path === "/api/state") return route.fulfill(json(saved));
    if (path === "/api/presentation/state") return route.fulfill(json({ ...basePresentation, screen: "hub" }));
    if (path === "/api/buzzer/info") return route.fulfill(json({ joinUrl: "http://quiz.local/player", displayUrl: "http://quiz.local/display" }));
    if (path === "/api/buzzer/state" || path === "/api/buzzer/control") return route.fulfill(json(buzzerState));
    if (path.startsWith("/api/team-lobby/")) return route.fulfill(json(lobby));
    if (path === "/api/ordering/state" || path === "/api/ordering/control") return route.fulfill(json(ordering));
    if (path === "/api/listing/state" || path === "/api/listing/control") return route.fulfill(json(listing));
    if (path === "/api/sync/state" || path === "/api/sync/control") return route.fulfill(json(sync));
    if (path === "/api/final-export") return route.fulfill(json({ created: true, directory: "visual-tests" }));
    return route.continue();
  });
  return live;
}

export async function mockPlayer(page, snapshot) {
  await page.addInitScript(() => {
    localStorage.setItem("quiz-buzzer-device", "visual-device-0001");
    localStorage.setItem("quiz-buzzer-team", JSON.stringify({ index: 0, revision: "visual" }));
  });
  await mockLiveSocket(page, snapshot);
  await page.route("**/api/player/commands", (route) => route.fulfill(json({ accepted: true })));
}

export function playerSnapshot(presentation, overrides = {}) {
  return liveSnapshot(presentation, {
    teamLobby: { ...teamLobby, phase: "locked" },
    buzzer, ordering: orderingBase, listing: listingBase, sync: syncLobby, ...overrides
  });
}

export function displayPresentation(screen, extra = {}) {
  return { ...basePresentation, screen, ...extra };
}

export { logos };
