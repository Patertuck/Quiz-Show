import { state } from "./store.js";

let publishChain = Promise.resolve();
let joinOverlay = null;

function teams() {
  return state.teams.map(({ name, score }) => ({ name, score }));
}

function base(screen) {
  return { screen, title: state.config?.title || "Quiz Show", teams: teams(), joinOverlay };
}

function media(image) {
  return image ? { src: image.src, alt: image.alt } : null;
}

export function publishPresentation(snapshot) {
  publishChain = publishChain.catch(() => undefined).then(async () => {
    const response = await fetch("/api/presentation/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${response.status}`);
    }
  }).catch((error) => {
    console.error("Could not update the audience display:", error);
    throw error;
  });
  return publishChain;
}

export function publishStandby() {
  return publishPresentation(base("standby"));
}

export function publishJeopardy() {
  if (!state.activeQuestion) {
    return publishPresentation({
      ...base("jeopardy-board"),
      board: {
        categories: state.config.categories.map(({ name }) => name),
        values: [...state.config.values],
        usedTiles: Array.from(state.usedTiles).sort()
      }
    });
  }
  const { categoryIndex, rowIndex, answerRevealed } = state.activeQuestion;
  const item = state.config.categories[categoryIndex].questions[rowIndex];
  return publishPresentation({
    ...base("jeopardy-question"),
    question: {
      id: `${categoryIndex}:${rowIndex}`,
      value: state.config.values[rowIndex],
      question: typeof item.question === "string" ? item.question : null,
      questionImage: media(item.questionImage),
      answerRevealed,
      answer: answerRevealed && typeof item.answer === "string" ? item.answer : null,
      answerImage: answerRevealed ? media(item.answerImage) : null
    }
  });
}

export function publishOrdering() {
  return publishPresentation(base("ordering"));
}

export function publishListing() {
  return publishPresentation(base("listing"));
}

export function publishSync() {
  return publishPresentation(base("sync"));
}

export async function setJoinOverlay(joinUrl = null) {
  joinOverlay = typeof joinUrl === "string" && joinUrl ? { joinUrl } : null;
  const response = await fetch("/api/presentation/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { version: _version, ...current } = await response.json();
  return publishPresentation({ ...current, joinOverlay });
}

export function publishVictory(steps, revealedCount) {
  return publishPresentation({ ...base("victory"), steps, revealedCount });
}
