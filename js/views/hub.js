import { publishHub } from "../presentation-host.js";

export function mount(root) {
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
