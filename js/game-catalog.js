export const GAME_CATALOG = Object.freeze([
  Object.freeze({ id: "jeopardy", label: "Jeopardy", logo: "assets/Logos/Logo_Jeopardy.png", template: "views/jeopardy.html", scoreboard: "game" }),
  Object.freeze({ id: "ordering", label: "Order Up", logo: "assets/Logos/Logo_Order_Up.png", template: "views/ordering.html", scoreboard: "standings" }),
  Object.freeze({ id: "listing", label: "List It", logo: "assets/Logos/Logo_List_It.png", template: "views/listing.html", scoreboard: "standings" }),
  Object.freeze({ id: "sync", label: "Sync Up", logo: "assets/Logos/Logo_Sync_Up.png", template: "views/sync.html", scoreboard: "standings" })
]);

const GAME_BY_ID = new Map(GAME_CATALOG.map((game) => [game.id, game]));

export function gameDefinition(id) {
  return GAME_BY_ID.get(id) || null;
}

export function configuredGames(config) {
  return GAME_CATALOG.filter(({ id }) => Object.hasOwn(config?.games || {}, id));
}

export function hasConfiguredGame(config, id) {
  return Object.hasOwn(config?.games || {}, id);
}

export function configuredGameIds(config) {
  return configuredGames(config).map(({ id }) => id);
}
