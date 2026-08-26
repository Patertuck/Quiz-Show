import { publishHub } from "../presentation-host.js";
import { configuredGames } from "../game-catalog.js";
import { state } from "../store.js";

export function mount(root) {
  const gameContainer = root.querySelector(".game-cards");
  const games = configuredGames(state.config);
  gameContainer.style.setProperty("--game-count", games.length);
  gameContainer.style.setProperty("--game-width", `${games.length * 100}cqh`);
  gameContainer.style.setProperty("--game-max-width", `${games.length * 24}rem`);
  games.forEach((game) => {
    const card = document.createElement("a");
    card.className = "game-card";
    card.href = `#/${game.id}`;
    const image = document.createElement("img");
    image.src = game.logo;
    image.alt = game.label;
    card.append(image);
    gameContainer.append(card);
  });
  const cards = [...root.querySelectorAll(".game-card")];
  let highlightedGame = null;

  function gameId(card) {
    return card.getAttribute("href")?.replace(/^#\//, "") || null;
  }

  function publishHighlight(nextGame) {
    if (nextGame === highlightedGame) return;
    highlightedGame = nextGame;
    publishHub(highlightedGame).catch(() => undefined);
  }

  const listeners = [];
  cards.forEach((card) => {
    const enter = () => publishHighlight(gameId(card));
    const leave = () => publishHighlight(null);
    card.addEventListener("pointerenter", enter);
    card.addEventListener("pointerleave", leave);
    card.addEventListener("focus", enter);
    card.addEventListener("blur", leave);
    listeners.push([card, enter, leave]);
  });

  publishHub().catch(() => undefined);
  return () => listeners.forEach(([card, enter, leave]) => {
    card.removeEventListener("pointerenter", enter);
    card.removeEventListener("pointerleave", leave);
    card.removeEventListener("focus", enter);
    card.removeEventListener("blur", leave);
  });
}
