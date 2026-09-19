import { GAME_CATALOG } from "../game-catalog.js";

export function createHostRoutes({ setup, master, start, hub, victory, games }) {
  const gameRoutes = Object.fromEntries(GAME_CATALOG.map((game) => [game.id, {
    template: game.template,
    controller: games[game.id],
    scoreboard: game.scoreboard,
    requiresGame: true,
    gameId: game.id
  }]));
  return {
    master: { template: "views/master.html", controller: master, scoreboard: "hidden", requiresGame: false, requiresConfig: false, hostControls: "hidden" },
    start: { template: "views/start.html", controller: start, scoreboard: "hidden", requiresGame: false, hostControls: "hidden" },
    setup: { template: "views/setup.html", controller: setup, scoreboard: "hidden", requiresGame: false, hostControls: "hidden" },
    hub: { template: "views/hub.html", controller: hub, scoreboard: "standings", requiresGame: true },
    ...gameRoutes,
    victory: { template: "views/victory.html", controller: victory, scoreboard: "hidden", requiresGame: true }
  };
}

