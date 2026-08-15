import { state } from "./store.js";

let publishChain = Promise.resolve();
let latestPresentation = null;
let joinOverlay = null;
let jeopardyAudioCommand = null;
const AUDIO_SETTINGS_STORAGE_KEY = "quiz-display-audio-settings-v1";
const defaultAudioSettings = {
  effectsEnabled: true,
  tensionMusicEnabled: true,
  ambientMusicEnabled: true
};

function cleanAudioSettings(value) {
  if (!value || typeof value !== "object") return { ...defaultAudioSettings };
  return Object.fromEntries(Object.entries(defaultAudioSettings).map(([key, fallback]) => [
    key, typeof value[key] === "boolean" ? value[key] : fallback
  ]));
}

function loadAudioSettings() {
  try { return cleanAudioSettings(JSON.parse(localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY))); }
  catch { return { ...defaultAudioSettings }; }
}

let audioSettings = loadAudioSettings();

function teams() {
  return state.teams.map(({ name, score }) => ({ name, score }));
}

function base(screen) {
  return { screen, title: state.config?.title || "Quiz Show", teams: teams(), joinOverlay, audioSettings };
}

function media(image) {
  return image ? { src: image.src, alt: image.alt } : null;
}

function audio(track) {
  return track ? { src: track.src, label: track.label } : null;
}

export function commandJeopardyAudio(action, target = null) {
  jeopardyAudioCommand = { id: crypto.randomUUID(), action, target };
  return publishJeopardy();
}

export function publishPresentation(snapshot) {
  const nextPresentation = { ...snapshot, audioSettings };
  latestPresentation = nextPresentation;
  publishChain = publishChain.catch(() => undefined).then(async () => {
    const response = await fetch("/api/presentation/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextPresentation)
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

export function publishIntro(headsVisible = false) {
  return publishPresentation({ ...base("intro"), headsVisible });
}

export function getDisplayAudioSettings() {
  return { ...audioSettings };
}

export async function setDisplayAudioSettings(nextSettings) {
  audioSettings = cleanAudioSettings(nextSettings);
  try { localStorage.setItem(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(audioSettings)); }
  catch (error) { console.warn("Could not persist display audio settings:", error); }
  if (latestPresentation) return publishPresentation({ ...latestPresentation, audioSettings });
  const response = await fetch("/api/presentation/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { version: _version, ...current } = await response.json();
  return publishPresentation({ ...current, audioSettings });
}

export function publishTeamLobby(joinUrl) {
  return publishPresentation({ ...base("team-lobby"), joinUrl });
}

export function publishWarmupQuestion(questionIndex, questionCount, questionText, concealedImageCount = 0) {
  return publishPresentation({
    ...base("warmup-question"), questionIndex, questionCount, questionText, concealedImageCount
  });
}

export function publishHub(highlightedGame = null) {
  return publishPresentation({ ...base("hub"), highlightedGame });
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
      questionAudio: audio(item.questionAudio),
      answerRevealed,
      answer: answerRevealed && typeof item.answer === "string" ? item.answer : null,
      answerImage: answerRevealed ? media(item.answerImage) : null,
      answerAudio: answerRevealed ? audio(item.answerAudio) : null,
      audioCommand: jeopardyAudioCommand
    }
  });
}

export function publishOrdering(questionSelection = null, orderingMap = null) {
  return publishPresentation({ ...base("ordering"), questionSelection, orderingMap });
}

export function publishListing(questionSelection = null) {
  return publishPresentation({ ...base("listing"), questionSelection });
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

export function publishScoreHistory(scoreHistory) {
  return publishPresentation({
    ...base("score-history"),
    scoreHistory: scoreHistory.map(({ scores }) => ({ scores: [...scores] }))
  });
}
