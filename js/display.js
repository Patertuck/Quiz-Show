import { animateScoreDistribution } from "./display-score-animation.js?v=7";
import qrcode from "../assets/vendor/qrcode.js";
import { startLivePolling, usesQuickTunnelPolling } from "./live-state.js?v=1";
import { scheduleTextFit } from "./fit-text.js";
import { createIntroHeads } from "./intro-heads.js?v=10";
import { createScoreHistoryChart } from "./score-history-chart.js?v=4";
import {
  playBuzzerSound,
  playWinnerCheer,
  setDisplaySoundBlockedHandler,
  setDisplaySoundSettings,
  setDisplaySoundsEnabled,
  startVictoryDrumroll,
  stopVictoryDrumroll,
  stopVictorySounds,
  syncBackgroundMusic,
  unlockDisplaySounds
} from "./display-sounds.js?v=9";

const root = document.querySelector("#display-root");
const connection = document.querySelector("#display-connection");
const audioUnlock = document.querySelector("#display-audio-unlock");
const jeopardyAudio = new Audio();
let jeopardyAudioSource = null;
let lastJeopardyAudioCommandId = null;
let pendingJeopardyAudioCommand = null;
let displayAudioEnabled = false;
let audioInteractionRequired = true;
let resumeJeopardyAudioAfterEnable = false;
let presentation = null;
let buzzer = null;
let buzzerInitialized = false;
let orderingState = null;
let listingState = null;
let syncState = null;
let teamLobbyState = null;
let highlightedLobbyTeamIds = new Set();
let orderingTicker;
let stopIntroHeads = null;
let listingTicker;
let syncTicker;
let activeGameEventSource = null;
let activeGameEventScreen = null;
let displayScoreAnimationActive = false;
const SCREEN_TRANSITION_DURATION_MS = 650;
let lastRenderedSceneKey = null;
let activeScreenTransition = null;
let fallbackTransitionTimer;
const presentationQueue = [];
const animatedOrderingRounds = new Set();
const animatedListingRounds = new Set();
const animatedSyncRounds = new Set();
const standbyLogoSource = "assets/Logos/Logo-1024.webp";
const standbyLogoRetryDelay = 2000;
const usePollingTransport = usesQuickTunnelPolling();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function logoImage(className) {
  const logo = element("img", className);
  let retryTimer;
  logo.addEventListener("load", () => clearTimeout(retryTimer));
  logo.addEventListener("error", () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!logo.isConnected) return;
      logo.src = `${standbyLogoSource}?retry=${Date.now()}`;
    }, standbyLogoRetryDelay);
  });
  logo.src = standbyLogoSource;
  logo.alt = "";
  logo.setAttribute("aria-hidden", "true");
  return logo;
}

function renderMedia(container, text, image) {
  if (typeof text === "string" && text.trim()) {
    container.append(element("div", text.length > 280 ? "auto-fit-text long-text" : "auto-fit-text", text));
  }
  if (image) {
    const picture = document.createElement("img");
    picture.alt = image.alt;
    picture.addEventListener("load", () => scheduleTextFit(picture.closest(".display-question-content")), { once: true });
    picture.addEventListener("error", () => {
      const content = picture.closest(".display-question-content");
      picture.replaceWith(element("div", "", "Bild nicht verfügbar"));
      scheduleTextFit(content);
    }, { once: true });
    picture.src = image.src;
    container.append(picture);
  }
}

function scoreboard(teams) {
  const board = element("aside", "display-scoreboard");
  board.setAttribute("aria-label", "Punktestände der Teams");
  teams.forEach((team, teamIndex) => {
    const rank = 1 + teams.filter((candidate) => candidate.score > team.score).length;
    const card = element("section", `display-team rank-${rank}`);
    card.dataset.teamIndex = teamIndex;
    card.append(element("div", "display-team-name", team.name), element("div", "display-team-score", team.score.toLocaleString()));
    board.append(card);
  });
  return board;
}

function standby() {
  const screen = element("section", "display-screen display-standby");
  const content = element("div", "display-standby-content");
  content.append(
    logoImage("display-standby-logo"),
    element("h1", "", presentation.title),
    element("p", "", "Warten auf das nächste Spiel")
  );
  screen.append(content);
  return screen;
}

function intro() {
  const screen = element("section", "display-screen display-intro");
  const background = element("video", "display-intro-background");
  background.src = "assets/Logos/background animation loop.mp4";
  background.autoplay = true;
  background.muted = true;
  background.loop = true;
  background.playsInline = true;
  background.setAttribute("aria-hidden", "true");
  const logo = element("video", "display-intro-logo");
  logo.src = "assets/Logos/Logo_animated_alpha.webm";
  logo.autoplay = true;
  logo.muted = true;
  logo.loop = true;
  logo.playsInline = true;
  logo.setAttribute("aria-hidden", "true");
  screen.append(background, logo);
  return screen;
}

function teamLobby() {
  const screen = element("section", "display-screen display-team-lobby");
  const heading = element("header", "display-team-lobby-heading");
  heading.append(
    element("h1", "", "Teams erstellen und beitreten"),
    element("p", "", `${teamLobbyState?.teams?.length || 0} von ${teamLobbyState?.maxTeams || 12} Teams`)
  );
  const join = element("aside", "display-team-lobby-join");
  const code = element("div", "display-team-lobby-qr");
  const qr = qrcode(0, "M");
  qr.addData(presentation.joinUrl);
  qr.make();
  code.innerHTML = qr.createSvgTag({ cellSize: 10, margin: 14, scalable: true, title: "QR-Code für Quizspieler" });
  join.append(element("h2", "", "QR-Code scannen"), code, element("p", "", presentation.joinUrl));
  const roster = element("main", "display-team-lobby-roster");
  if (teamLobbyState?.teams?.length) {
    teamLobbyState.teams.forEach((team) => {
      const card = element("section", "display-team-lobby-team");
      card.classList.toggle("fresh-activity", highlightedLobbyTeamIds.has(team.id));
      card.append(
        element("strong", "", team.name),
        element("span", "", `${team.memberCount} ${team.memberCount === 1 ? "Handy" : "Handys"}`)
      );
      roster.append(card);
    });
  } else {
    roster.append(element("p", "display-team-lobby-empty", "Noch keine Teams vorhanden"));
  }
  screen.append(heading, join, roster);
  return screen;
}

function warmupQuestion() {
  const screen = element("section", "display-screen display-warmup");
  screen.append(element("h1", "display-warmup-question", presentation.questionText));
  if (presentation.concealedImageCount) {
    const images = element("div", "display-warmup-concealed-images");
    for (let index = 0; index < presentation.concealedImageCount; index += 1) {
      const placeholder = element("div", "display-warmup-concealed-image");
      placeholder.setAttribute("role", "img");
      placeholder.setAttribute("aria-label", `Verdecktes Bild ${index + 1}`);
      placeholder.append(
        element("strong", "", "?"),
        element("span", "", `Bild ${index + 1} verdeckt`)
      );
      images.append(placeholder);
    }
    screen.append(images);
  }
  scheduleTextFit(screen, ".display-warmup-question");
  return screen;
}

function receiveTeamLobbyState(nextState) {
  const previousTeams = new Map((teamLobbyState?.teams || []).map((team) => [team.id, team]));
  highlightedLobbyTeamIds = new Set();
  if (teamLobbyState) {
    nextState.teams.forEach((team) => {
      const previous = previousTeams.get(team.id);
      if (!previous || team.memberCount > previous.memberCount) highlightedLobbyTeamIds.add(team.id);
    });
  }
  teamLobbyState = nextState;
}

const hubGames = [
  { id: "jeopardy", src: "assets/Logos/Logo_Jeopardy.png", alt: "Jeopardy" },
  { id: "ordering", src: "assets/Logos/Logo_Order_Up.png", alt: "Order Up" },
  { id: "listing", src: "assets/Logos/Logo_List_It.png", alt: "List It" },
  { id: "sync", src: "assets/Logos/Logo_Sync_Up.png", alt: "Sync Up" }
];

function hub() {
  const screen = element("section", "display-screen display-hub");
  screen.append(element("h1", "", presentation.title));
  const area = element("div", "display-hub-game-area");
  const games = element("div", "display-hub-games");
  hubGames.forEach((game) => {
    const card = element("div", `display-hub-game${presentation.highlightedGame === game.id ? " highlighted" : ""}`);
    card.dataset.game = game.id;
    const image = element("img");
    image.src = game.src;
    image.alt = game.alt;
    card.append(image);
    games.append(card);
  });
  area.append(games);
  screen.append(area);
  return screen;
}

function jeopardyBoard() {
  const screen = element("section", "display-screen display-board-screen");
  screen.append(element("h1", "display-game-title", presentation.title));
  const board = element("div", "display-board");
  const { categories, values, usedTiles } = presentation.board;
  const used = new Set(usedTiles);
  board.style.gridTemplateColumns = `repeat(${categories.length}, minmax(0, 1fr))`;
  board.style.gridTemplateRows = `minmax(0, 1.1fr) repeat(${values.length}, minmax(0, 1fr))`;
  categories.forEach((category) => board.append(element("div", "display-category", category)));
  values.forEach((value, row) => categories.forEach((_, category) => {
    board.append(element("div", `display-tile${used.has(`${category}:${row}`) ? " used" : ""}`, value.toLocaleString()));
  }));
  screen.append(board);
  requestAnimationFrame(() => fitBoard(board, categories.length, values.length));
  return screen;
}

function fitBoard(board, columns, rows) {
  const columnWidth = board.clientWidth / columns;
  const rowHeight = board.clientHeight / (rows + 1.1);
  board.style.setProperty("--category-font-size", `${Math.max(6, Math.min(21, columnWidth * 0.15, rowHeight * 0.32))}px`);
  board.style.setProperty("--tile-font-size", `${Math.max(8, Math.min(35, columnWidth * 0.27, rowHeight * 0.48))}px`);
  board.style.setProperty("--board-gap", `${Math.max(1, Math.min(5, columnWidth * 0.02, rowHeight * 0.04))}px`);
  board.style.setProperty("--cell-padding", `${Math.max(1, Math.min(12, columnWidth * 0.05, rowHeight * 0.1))}px`);
}

function jeopardyQuestion() {
  const screen = element("section", "display-screen display-question");
  const content = element("div", "display-question-content");
  content.append(element(
    "div",
    "display-question-value",
    `±${presentation.question.value.toLocaleString("de-CH")} Punkte`
  ));
  if (presentation.question.answerRevealed) {
    const answer = element("div", "display-media answer answer-only");
    renderMedia(answer, presentation.question.answer, presentation.question.answerImage);
    if (presentation.question.answerAudio) {
      answer.append(element("div", "display-audio-label", `🎵 ${presentation.question.answerAudio.label}`));
    }
    content.append(answer);
  } else {
    const question = element("div", "display-media");
    renderMedia(question, presentation.question.question, presentation.question.questionImage);
    if (presentation.question.questionAudio) {
      question.append(element("div", "display-audio-label", `🎵 ${presentation.question.questionAudio.label}`));
    }
    content.append(question);
  }
  const buzzOrder = element("aside", "display-buzz-order");
  buzzOrder.setAttribute("aria-label", "Buzzer-Reihenfolge");
  buzzOrder.append(element("strong", "display-buzz-label", "Buzzer-Reihenfolge"), element("ol", "display-buzz-list"));
  screen.append(content, buzzOrder);
  scheduleTextFit(content);
  return screen;
}

function ordering() {
  const screen = element("section", "display-screen display-ordering");
  const round = orderingState?.round;
  if (!round) {
    const selection = presentation.questionSelection;
    const content = element("div", "display-ordering-selection");
    content.append(element("h1", "", "Order Up"));
    if (selection?.selectedQuestion) {
      const preview = element("section", "display-ordering-question-preview");
      preview.append(
        element("h2", "", selection.selectedQuestion.title),
        element("p", "", selection.selectedQuestion.prompt)
      );
      const items = element("div", "display-ordering-preview-items");
      selection.selectedQuestion.items.forEach((item) => {
        items.append(element("div", "display-ordering-preview-item", item));
      });
      preview.append(items);
      content.append(preview);
      screen.append(content);
    } else if (selection?.questions?.length) {
      const grid = element("div", "display-ordering-question-grid");
      selection.questions.forEach((question) => {
        const card = element("div", "display-ordering-question-card", question.title);
        card.classList.toggle("completed", question.completed);
        card.classList.toggle("highlighted", selection.highlightedQuestionId === question.id);
        grid.append(card);
      });
      content.append(grid);
      screen.append(content);
    } else {
      content.append(element("p", "", "Macht euch bereit für die nächste Herausforderung."));
      screen.append(content);
    }
    return screen;
  }
  if (round.phase === "active") {
    const content = element("div", "display-ordering-active");
    content.append(
      element("h1", "", round.title),
      element("p", "display-ordering-prompt", round.prompt),
      element("output", "display-ordering-timer", String(Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000)))),
      element("p", "display-ordering-connected", `${orderingState.connectedTeamCount} von ${orderingState.teams.length} Teams verbunden`)
    );
    content.querySelector("output").dataset.deadline = round.deadlineAt;
    screen.append(content);
    return screen;
  }
  const heading = element("header", "display-ordering-heading");
  heading.append(element("h1", "", round.title), element("p", "", round.prompt));
  const board = element("div", "display-ordering-results");
  const split = Math.ceil(orderingState.teams.length / 2);
  const left = element("div", "display-ordering-side");
  const right = element("div", "display-ordering-side");
  const itemNames = new Map(round.shuffledItems.map((item) => [item.id, item.text]));
  orderingState.teams.forEach((name, teamIndex) => {
    const column = element("section", "display-ordering-column");
    column.dataset.teamIndex = teamIndex;
    column.style.setProperty("--ordering-count", round.teamOrders[teamIndex].length);
    const title = element("h2");
    title.append(element("span", "", name), element("strong", "", `+${round.roundPoints[teamIndex]}`));
    column.append(title);
    round.teamOrders[teamIndex].forEach((id, slot) => {
      const revealed = round.revealed.includes(slot);
      const correct = revealed && id === round.revealedItems[slot]?.id;
      column.append(element("div", `display-ordering-cell${revealed ? (correct ? " correct" : " wrong") : ""}`, itemNames.get(id)));
    });
    (teamIndex < split ? left : right).append(column);
  });
  const solution = element("section", "display-ordering-column display-ordering-solution");
  solution.style.setProperty("--ordering-count", round.revealedItems.length);
  solution.append(element("h2", "", "Richtige Reihenfolge"));
  round.revealedItems.forEach((item, slot) => solution.append(element("div", `display-ordering-cell${item ? " revealed" : " hidden-answer"}`, item?.text || `Antwort ${slot + 1}`)));
  board.append(left, solution, right);
  if (presentation.orderingMap && round.phase !== "active") {
    const overlay = element("section", "display-ordering-map");
    const image = element("img");
    image.src = presentation.orderingMap.image.src;
    image.alt = presentation.orderingMap.image.alt;
    overlay.append(element("h2", "", presentation.orderingMap.label), image);
    screen.append(heading, overlay);
  } else {
    screen.append(heading, board);
  }
  return screen;
}

function listing() {
  const screen = element("section", "display-screen display-listing");
  const round = listingState?.round;
  if (!round) {
    const selection = presentation.questionSelection;
    const content = element("div", "display-listing-selection");
    content.append(element("h1", "", "List It"));
    if (selection?.selectedQuestion) {
      const preview = element("section", "display-listing-question-preview");
      preview.append(
        element("h2", "", selection.selectedQuestion.title),
        element("p", "", selection.selectedQuestion.prompt)
      );
      content.append(preview);
      screen.append(content);
    } else if (selection?.questions?.length) {
      const grid = element("div", "display-listing-question-grid");
      selection.questions.forEach((question) => {
        const card = element("div", "display-listing-question-card", question.displayCategory);
        card.classList.toggle("completed", question.completed);
        card.classList.toggle("highlighted", selection.highlightedQuestionId === question.id);
        grid.append(card);
      });
      content.append(grid);
      screen.append(content);
    } else {
      content.append(element("p", "", "Macht euch bereit für die nächste Aufgabe."));
      screen.append(content);
    }
    return screen;
  }
  if (round.phase === "active") {
    const content = element("div", "display-listing-active");
    const timer = element("output", "display-listing-timer", String(Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000))));
    timer.dataset.deadline = round.deadlineAt;
    content.append(
      element("h1", "", round.title),
      element("p", "display-listing-prompt", round.prompt),
      timer,
      element("p", "display-listing-progress", `${round.submittedCount} von ${listingState.teams.length} Teams haben abgegeben`)
    );
    screen.append(content);
    return screen;
  }
  if (round.phase === "classifying") {
    const content = element("div", "display-listing-classifying");
    content.append(element("div", "display-listing-spinner"), element("h1", "", "Antworten werden geprüft …"));
    screen.append(content);
    return screen;
  }
  if (round.phase === "review" && round.review) {
    const content = element("div", "display-listing-review");
    content.append(
      element("p", "display-listing-review-progress", `Prüfung ${round.review.index + 1} von ${round.review.total}`),
      element("p", "display-listing-team", listingState.teams[round.review.teamIndex]),
      element("h1", "display-listing-answer", round.review.text)
    );
    screen.append(content);
    return screen;
  }
  if (round.phase === "results" && round.resultView?.mode === "team") {
    const position = round.resultView.teamPosition || 0;
    const result = round.results?.[position];
    const content = element("div", "display-listing-team-result");
    if (!result) {
      content.append(element("h1", "", "Keine Teamergebnisse"));
      screen.append(content);
      return screen;
    }
    const heading = element("header", "display-listing-team-heading");
    heading.append(
      element("strong", "display-listing-team-place", `${result.place}. Platz`),
      element("h1", "", listingState.teams[result.teamIndex])
    );
    const items = element("div", "display-listing-items");
    if (!result.items?.length) {
      items.append(element("p", "display-listing-empty", "Keine Begriffe eingereicht"));
    } else {
      result.items.forEach((item) => {
        const card = element("div", `display-listing-item ${item.status}`);
        card.title = item.text;
        card.append(element("span", "display-listing-item-text", item.text));
        items.append(card);
        scheduleTextFit(card, ".display-listing-item-text");
      });
    }
    content.append(heading, items, element(
      "p", "display-listing-team-count",
      `${result.acceptedCount} Punkte`
    ));
    screen.append(content);
    return screen;
  }
  const content = element("div", "display-listing-results");
  content.append(element("h1", "", "Rangliste"));
  const rows = element("div", "display-listing-result-rows");
  [...(round.results || [])].sort((a, b) => a.place - b.place || a.teamIndex - b.teamIndex).forEach((result) => {
    const row = element("section", "display-listing-result-row");
    row.dataset.teamIndex = result.teamIndex;
    row.append(
      element("strong", "display-listing-place", `${result.place}.`),
      element("span", "display-listing-result-team", listingState.teams[result.teamIndex]),
      element("span", "display-listing-count", `${result.acceptedCount} gültig`),
      element("strong", "display-listing-points", `+${result.points}`)
    );
    rows.append(row);
  });
  content.append(rows);
  screen.append(content);
  return screen;
}

function audioTrackFor(command) {
  if (!presentation?.question || !command?.target) return null;
  return command.target === "answer" ? presentation.question.answerAudio : presentation.question.questionAudio;
}

function backgroundMusicMode() {
  if (!presentation || !displayAudioEnabled || !jeopardyAudio.paused
      || ["standby", "victory"].includes(presentation.screen)) return "silent";
  if (presentation.screen === "jeopardy-question" && !presentation.question?.answerRevealed) {
    const round = buzzer?.round;
    const hasBuzz = round?.questionId === presentation.question?.id && Boolean(round.buzzes?.length);
    return hasBuzz ? "silent" : "tension";
  }
  if (presentation.screen === "ordering" && orderingState?.round?.phase === "active") return "tension";
  if (presentation.screen === "listing" && listingState?.round?.phase === "active") return "tension";
  if (presentation.screen === "sync" && syncState?.round?.phase === "active") return "tension";
  return "ambient";
}

function syncDisplayBackgroundMusic(immediate = false) {
  syncBackgroundMusic(backgroundMusicMode(), immediate);
}

function updateAudioButton() {
  audioUnlock.hidden = false;
  audioUnlock.classList.toggle("needs-interaction", audioInteractionRequired);
  audioUnlock.textContent = displayAudioEnabled ? "🔊 Audio an" : "🔇 Audio aus";
  audioUnlock.setAttribute("aria-pressed", String(displayAudioEnabled));
  audioUnlock.title = displayAudioEnabled ? "Gesamtes Display-Audio ausschalten" : "Gesamtes Display-Audio einschalten";
}

async function executeJeopardyAudio(command) {
  if (command.action === "stop") {
    jeopardyAudio.pause();
    jeopardyAudio.currentTime = 0;
    pendingJeopardyAudioCommand = null;
    resumeJeopardyAudioAfterEnable = false;
    syncDisplayBackgroundMusic();
    return;
  }
  if (command.action === "pause") {
    jeopardyAudio.pause();
    pendingJeopardyAudioCommand = null;
    resumeJeopardyAudioAfterEnable = false;
    syncDisplayBackgroundMusic();
    return;
  }
  const track = audioTrackFor(command);
  if (!track) return;
  if (jeopardyAudioSource !== track.src) {
    jeopardyAudio.src = track.src;
    jeopardyAudioSource = track.src;
  }
  if (command.action === "restart") jeopardyAudio.currentTime = 0;
  if (!displayAudioEnabled) {
    pendingJeopardyAudioCommand = command;
    return;
  }
  try {
    await jeopardyAudio.play();
    pendingJeopardyAudioCommand = null;
    resumeJeopardyAudioAfterEnable = false;
    syncDisplayBackgroundMusic();
  } catch (error) {
    console.warn("Audio playback needs audience interaction:", error);
    pendingJeopardyAudioCommand = command;
    displayAudioEnabled = false;
    audioInteractionRequired = true;
    setDisplaySoundsEnabled(false);
    updateAudioButton();
  }
}

jeopardyAudio.addEventListener("error", () => {
  console.warn("Jeopardy audio could not be loaded.");
});
jeopardyAudio.addEventListener("play", () => syncDisplayBackgroundMusic(true));
jeopardyAudio.addEventListener("pause", () => syncDisplayBackgroundMusic());
jeopardyAudio.addEventListener("ended", () => syncDisplayBackgroundMusic());

function handleJeopardyAudioCommand() {
  const command = presentation?.screen === "jeopardy-question" ? presentation.question?.audioCommand : null;
  if (!command || command.id === lastJeopardyAudioCommandId) return;
  lastJeopardyAudioCommandId = command.id;
  executeJeopardyAudio(command);
}

setDisplaySoundBlockedHandler((error) => {
  console.warn("Automatic display audio was blocked:", error);
  displayAudioEnabled = false;
  audioInteractionRequired = true;
  setDisplaySoundsEnabled(false);
  updateAudioButton();
});

async function enableAudioFromInteraction() {
  if (displayAudioEnabled) return;
  await unlockDisplaySounds();
  displayAudioEnabled = true;
  audioInteractionRequired = false;
  setDisplaySoundsEnabled(true);
  updateAudioButton();
  if (pendingJeopardyAudioCommand) await executeJeopardyAudio(pendingJeopardyAudioCommand);
  else if (resumeJeopardyAudioAfterEnable) {
    try { await jeopardyAudio.play(); }
    catch (error) { console.warn("Jeopardy audio could not resume:", error); }
    resumeJeopardyAudioAfterEnable = false;
  }
  const winnerIndex = presentation?.screen === "victory"
    ? presentation.steps?.findIndex((step) => step.kind === "podium" && step.rank === 1) ?? -1
    : -1;
  if (winnerIndex >= 0 && presentation.revealedCount <= winnerIndex) startVictoryDrumroll();
  syncDisplayBackgroundMusic();
}

function disableDisplayAudio() {
  resumeJeopardyAudioAfterEnable = !jeopardyAudio.paused;
  displayAudioEnabled = false;
  audioInteractionRequired = false;
  jeopardyAudio.pause();
  setDisplaySoundsEnabled(false);
  updateAudioButton();
}

audioUnlock.addEventListener("click", () => {
  if (displayAudioEnabled) disableDisplayAudio();
  else enableAudioFromInteraction();
});
document.addEventListener("pointerdown", (event) => {
  if (event.target !== audioUnlock) enableAudioFromInteraction();
}, { once: true, capture: true });
document.addEventListener("keydown", (event) => {
  if (event.target !== audioUnlock) enableAudioFromInteraction();
}, { once: true, capture: true });
updateAudioButton();

function sync() {
  const screen = element("section", "display-screen display-sync");
  const round = syncState?.round;
  const shell = element("div", "sync-shell");
  const heading = element("header", "sync-heading");
  const status = element("p", "");
  const content = element("main", "");
  status.setAttribute("aria-live", "polite");
  content.id = "sync-content";
  heading.append(element("h1", "", "Sync Up"), status);
  shell.append(heading, content);
  screen.append(shell);

  if (!syncState?.rosterLocked) {
    const connected = new Set(syncState?.connectedParticipantIds || []);
    status.textContent = "Alle Mitspielenden wählen auf dem Handy ihr Team und tragen ihren Namen ein.";
    const teams = element("div", "sync-roster");
    syncState?.teams.forEach((team, teamIndex) => {
      const card = element("section", "sync-roster-team");
      card.append(element("h2", "", team));
      const members = syncState.participants.filter((person) => person.teamIndex === teamIndex);
      if (!members.length) card.append(element("p", "", "Noch niemand registriert"));
      members.forEach((person) => card.append(element(
        "div", `sync-roster-person${connected.has(person.id) ? " connected" : ""}`, person.name
      )));
      teams.append(card);
    });
    content.append(teams);
    return screen;
  }
  if (!round) {
    status.textContent = "Warten auf den nächsten Prompt";
    return screen;
  }
  if (!["results", "distributed"].includes(round.phase)) {
    status.textContent = round.phase === "active"
      ? `${round.submittedCount} von ${syncState.participants.length} Antworten gewählt`
      : "";
    const panel = element("section", "sync-prompt-panel");
    panel.append(element("h2", "", round.prompt));
    const timer = element("output", "sync-host-timer",
      round.phase === "active" ? String(Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000))) : String(round.timeLimitSeconds));
    if (round.deadlineAt) timer.dataset.deadline = round.deadlineAt;
    panel.append(timer);
    content.append(panel);
    return screen;
  }
  heading.hidden = true;
  content.append(element("h2", "sync-result-prompt", round.prompt));
  const teams = element("div", "sync-result-teams");
  round.results.forEach((result) => {
    const card = element("section", `sync-result-team${result.synced ? " synced" : ""}`);
    card.dataset.teamIndex = result.teamIndex;
    card.append(
      element("h2", "", syncState.teams[result.teamIndex]),
      element("strong", "sync-result-points", `+${result.points}`)
    );
    result.votes.forEach((vote) => {
      const voter = syncState.participants.find((person) => person.id === vote.participantId)?.name || "?";
      const selected = syncState.participants.find((person) => person.id === vote.selectedParticipantId)?.name || "Keine Auswahl";
      card.append(element("div", "sync-result-vote", `${voter} → ${selected}`));
    });
    teams.append(card);
  });
  content.append(teams);
  return screen;
}

function victory() {
  const screen = element("section", "display-screen display-victory");
  screen.append(element("h1", "", "Endstand"));
  const standings = element("div", "display-standing-reveals");
  const podium = element("div", "display-podium");
  presentation.steps.forEach((step, index) => {
    if (step.kind === "standing") {
      const row = element("div", `display-standing${index < presentation.revealedCount ? " revealed" : ""}`);
      row.append(document.createTextNode(`Platz ${step.rank}: ${step.names} `), element("span", "display-standing-score", `${step.score.toLocaleString("de-CH")} Punkte`));
      standings.append(row);
    } else {
      const place = element("section", `display-podium-place rank-${step.rank}${index < presentation.revealedCount ? " revealed" : ""}`);
      place.append(
        element("div", "display-podium-rank", String(step.rank)),
        element("div", "display-podium-names", step.names),
        element("div", "display-podium-score", `${step.score.toLocaleString("de-CH")} Punkte`)
      );
      podium.append(place);
    }
  });
  screen.append(standings, podium);
  return screen;
}

function scoreHistory() {
  const screen = element("section", "display-screen display-score-history");
  screen.append(createScoreHistoryChart(presentation.teams, presentation.scoreHistory));
  return screen;
}

function syncVictorySounds(previousPresentation, nextPresentation, initial = false) {
  if (nextPresentation?.screen !== "victory") {
    if (previousPresentation?.screen === "victory") stopVictorySounds();
    return;
  }
  const winnerIndex = nextPresentation.steps?.findIndex(
    (step) => step.kind === "podium" && step.rank === 1
  ) ?? -1;
  if (winnerIndex < 0) return;
  const winnerRevealed = nextPresentation.revealedCount > winnerIndex;
  const previousWinnerIndex = previousPresentation?.screen === "victory"
    ? previousPresentation.steps?.findIndex((step) => step.kind === "podium" && step.rank === 1) ?? -1
    : -1;
  const winnerWasRevealed = previousWinnerIndex >= 0
    && previousPresentation.revealedCount > previousWinnerIndex;

  if (winnerRevealed) stopVictoryDrumroll();
  else startVictoryDrumroll();
  if (!initial && previousPresentation?.screen === "victory" && !winnerWasRevealed && winnerRevealed) {
    playWinnerCheer();
  }
}

function sceneKey() {
  if (!presentation) return null;
  if (presentation.screen === "jeopardy-question") {
    return `${presentation.screen}:${presentation.question?.id}:${presentation.question?.answerRevealed ? "answer" : "question"}`;
  }
  if (presentation.screen === "ordering") {
    const round = orderingState?.round;
    const view = !round ? "waiting" : round.phase === "active" ? "active" : "results";
    return `ordering:${round?.id || "none"}:${view}`;
  }
  if (presentation.screen === "listing") {
    const round = listingState?.round;
    if (!round) return `listing:waiting:${presentation.questionSelection?.selectedQuestion?.id || "overview"}`;
    if (round.phase === "review") return `listing:${round.id}:review:${round.review?.index ?? 0}`;
    if (["results", "distributed"].includes(round.phase)) {
      const resultView = round.resultView;
      return `listing:${round.id}:results:${resultView?.mode || "ranking"}:${resultView?.teamPosition ?? 0}`;
    }
    return `listing:${round.id}:${round.phase}`;
  }
  if (presentation.screen === "team-lobby") return "team-lobby";
  if (presentation.screen === "sync") {
    const round = syncState?.round;
    if (!syncState?.rosterLocked) return "sync:lobby";
    if (!round) return "sync:waiting";
    const view = ["results", "distributed"].includes(round.phase) ? "results" : round.phase;
    return `sync:${round.id}:${view}`;
  }
  return presentation.screen;
}

function renderImmediately() {
  if (!presentation) return;
  stopIntroHeads?.();
  stopIntroHeads = null;
  document.title = `${presentation.title} — Publikumsansicht`;
  document.body.classList.toggle("with-scoreboard", ["hub", "jeopardy-board", "jeopardy-question", "ordering", "listing", "sync"].includes(presentation.screen));
  const renderers = {
    standby,
    intro,
    "team-lobby": teamLobby,
    "warmup-question": warmupQuestion,
    hub,
    "jeopardy-board": jeopardyBoard,
    "jeopardy-question": jeopardyQuestion,
    ordering,
    listing,
    sync,
    victory,
    "score-history": scoreHistory
  };
  root.replaceChildren(renderers[presentation.screen]());
  if (presentation.screen === "intro" && presentation.headsVisible) {
    stopIntroHeads = createIntroHeads(root.querySelector(".display-intro"));
  }
  if (document.body.classList.contains("with-scoreboard")) root.append(scoreboard(presentation.teams));
  if (presentation.joinOverlay?.joinUrl) {
    const overlay = element("aside", "display-join-overlay");
    const card = element("div", "display-join-card");
    const code = element("div", "display-join-qr");
    const qr = qrcode(0, "M");
    qr.addData(presentation.joinOverlay.joinUrl);
    qr.make();
    code.innerHTML = qr.createSvgTag({
      cellSize: 10, margin: 16, scalable: true, title: "QR-Code für Quizspieler"
    });
    card.append(
      element("h1", "", "Mit dem Handy teilnehmen"),
      code,
      element("p", "", presentation.joinOverlay.joinUrl)
    );
    overlay.append(card);
    root.append(overlay);
  }
  if (presentation.screen === "team-lobby") highlightedLobbyTeamIds = new Set();
  updateBuzzerBanner();
}

function render() {
  if (!presentation) return;
  syncDisplayBackgroundMusic();
  const nextSceneKey = sceneKey();
  const shouldAnimate = lastRenderedSceneKey !== null
    && nextSceneKey !== lastRenderedSceneKey
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  lastRenderedSceneKey = nextSceneKey;

  if (!shouldAnimate) {
    renderImmediately();
    return;
  }

  if (typeof document.startViewTransition === "function") {
    activeScreenTransition?.skipTransition();
    const transition = document.startViewTransition(renderImmediately);
    activeScreenTransition = transition;
    transition.finished.finally(() => {
      if (activeScreenTransition === transition) activeScreenTransition = null;
    });
    return;
  }

  renderImmediately();
  clearTimeout(fallbackTransitionTimer);
  root.querySelectorAll(":scope > *").forEach((node) => node.classList.add("display-transition-enter"));
  fallbackTransitionTimer = setTimeout(() => {
    root.querySelectorAll(".display-transition-enter").forEach((node) => node.classList.remove("display-transition-enter"));
  }, SCREEN_TRANSITION_DURATION_MS);
}

function scoreChanges(nextPresentation) {
  return nextPresentation.teams.map((team, teamIndex) => ({
    teamIndex,
    points: team.score - (presentation.teams[teamIndex]?.score ?? team.score),
    oldScore: presentation.teams[teamIndex]?.score ?? team.score,
    newScore: team.score
  }));
}

function orderingAnimationPlan(nextPresentation) {
  const round = orderingState?.round;
  if (!presentation || presentation.screen !== "ordering" || nextPresentation.screen !== "ordering"
      || !round || animatedOrderingRounds.has(round.id)
      || round.phase !== "distributed"
      || round.revealed?.length !== round.shuffledItems?.length) return null;
  const awards = scoreChanges(nextPresentation);
  if (!awards.some(({ points }) => points > 0)
      || awards.some(({ points, teamIndex }) => points !== (round.roundPoints?.[teamIndex] || 0))) return null;
  const origins = awards.map(({ teamIndex }) => root.querySelector(
    `.display-ordering-column[data-team-index="${teamIndex}"] h2 strong`
  )?.getBoundingClientRect() || null);
  animatedOrderingRounds.add(round.id);
  return { awards: awards.filter(({ points }) => points > 0), origins };
}

function listingAnimationPlan(nextPresentation) {
  const round = listingState?.round;
  if (!presentation || presentation.screen !== "listing" || nextPresentation.screen !== "listing"
      || !round || animatedListingRounds.has(round.id)
      || !["results", "distributed"].includes(round.phase) || !Array.isArray(round.results)) return null;
  const expectedPoints = new Map(round.results.map(({ teamIndex, points }) => [teamIndex, points]));
  const awards = scoreChanges(nextPresentation);
  if (!awards.some(({ points }) => points > 0)
      || awards.some(({ points, teamIndex }) => points !== (expectedPoints.get(teamIndex) || 0))) return null;
  const origins = awards.map(({ teamIndex }) => root.querySelector(
    `.display-listing-result-row[data-team-index="${teamIndex}"] .display-listing-points`
  )?.getBoundingClientRect() || null);
  animatedListingRounds.add(round.id);
  return { awards: awards.filter(({ points }) => points > 0), origins };
}

function syncAnimationPlan(nextPresentation) {
  const round = syncState?.round;
  if (!presentation || presentation.screen !== "sync" || nextPresentation.screen !== "sync"
      || !round || animatedSyncRounds.has(round.id)
      || !["results", "distributed"].includes(round.phase) || !Array.isArray(round.results)) return null;
  const expectedPoints = new Map(round.results.map(({ teamIndex, points }) => [teamIndex, points]));
  const awards = scoreChanges(nextPresentation);
  if (!awards.some(({ points }) => points > 0)
      || awards.some(({ points, teamIndex }) => points !== (expectedPoints.get(teamIndex) || 0))) return null;
  const origins = awards.map(({ teamIndex }) => root.querySelector(
    `.sync-result-team[data-team-index="${teamIndex}"] .sync-result-points`
  )?.getBoundingClientRect() || null);
  animatedSyncRounds.add(round.id);
  return { awards: awards.filter(({ points }) => points > 0), origins };
}

function jeopardyAnimationPlan(nextPresentation) {
  if (!presentation || presentation.screen !== "jeopardy-question"
      || nextPresentation.screen !== "jeopardy-question"
      || presentation.question?.id !== nextPresentation.question?.id) return null;
  const awards = scoreChanges(nextPresentation).filter(({ points }) => points !== 0);
  if (!awards.length) return null;
  const origin = root.querySelector(".display-question-value")?.getBoundingClientRect() || null;
  return { awards, origins: nextPresentation.teams.map(() => origin) };
}

function audienceAnimationPlan(nextPresentation) {
  return jeopardyAnimationPlan(nextPresentation)
    || orderingAnimationPlan(nextPresentation)
    || listingAnimationPlan(nextPresentation)
    || syncAnimationPlan(nextPresentation);
}

async function drainPresentationQueue() {
  if (displayScoreAnimationActive) return;
  displayScoreAnimationActive = true;
  try {
    while (presentationQueue.length) {
      const nextPresentation = presentationQueue.shift();
      if (presentation?.serverSessionId === nextPresentation.serverSessionId
          && presentation?.version !== undefined && nextPresentation.version <= presentation.version) continue;
      const plan = audienceAnimationPlan(nextPresentation);
      const previousPresentation = presentation;
      presentation = nextPresentation;
      setDisplaySoundSettings(presentation.audioSettings);
      syncVictorySounds(previousPresentation, nextPresentation, previousPresentation === null);
      syncGameEventSource();
      handleJeopardyAudioCommand();
      render();
      if (plan) {
        await animateScoreDistribution({ root, ...plan });
        render();
      }
    }
  } finally {
    displayScoreAnimationActive = false;
  }
}

function receivePresentation(nextPresentation) {
  const latest = presentationQueue.at(-1) ?? presentation;
  if (latest?.serverSessionId === nextPresentation.serverSessionId
      && latest?.version !== undefined && nextPresentation.version <= latest.version) return;
  if (latest?.serverSessionId && latest.serverSessionId !== nextPresentation.serverSessionId) {
    presentationQueue.length = 0;
  }
  presentationQueue.push(nextPresentation);
  drainPresentationQueue().catch((error) => {
    console.error(error);
    presentation = nextPresentation;
    render();
  });
}

function receiveBuzzerState(nextBuzzer, initial = false) {
  const previousRound = buzzer?.round;
  const nextRound = nextBuzzer?.round;
  const sameRound = previousRound?.questionId && previousRound.questionId === nextRound?.questionId;
  const previousBuzzCount = sameRound ? (previousRound.buzzes?.length || 0) : 0;
  const nextBuzzCount = nextRound?.buzzes?.length || 0;
  buzzer = nextBuzzer;
  const firstBuzz = !initial && buzzerInitialized && previousBuzzCount === 0 && nextBuzzCount > 0;
  syncDisplayBackgroundMusic(firstBuzz);
  if (firstBuzz) playBuzzerSound();
  buzzerInitialized = true;
  updateBuzzerBanner();
}

function updateBuzzerBanner() {
  const order = root.querySelector(".display-buzz-order");
  const list = order?.querySelector(".display-buzz-list");
  const round = buzzer?.round;
  if (!order || !list || !presentation?.question || round?.questionId !== presentation.question.id
      || !round.buzzes.length) {
    if (order) {
      order.hidden = true;
      scheduleTextFit(root.querySelector(".display-question-content"));
    }
    return;
  }
  const activePosition = round.buzzes.findIndex((entry) => entry.teamIndex === round.activeTeamIndex);
  list.style.setProperty("--team-count", String(Math.max(1, presentation.teams.length)));
  list.replaceChildren(...round.buzzes.map((entry, index) => {
    const item = element("li", "", entry.teamName);
    item.classList.toggle("active", index === activePosition);
    item.classList.toggle("answered", activePosition === -1 ? true : index < activePosition);
    return item;
  }));
  order.hidden = false;
  scheduleTextFit(root.querySelector(".display-question-content"));
}

window.addEventListener("resize", () => scheduleTextFit(root.querySelector(".display-question-content")));

async function initialState(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function setDisplayConnection(connected) {
  connection.textContent = connected ? "Verbunden" : "Verbindung zur Spielleitung wird wiederhergestellt…";
  connection.classList.toggle("connected", connected);
}

function receiveLiveSnapshot(snapshot) {
  receivePresentation(snapshot.presentation);
  receiveBuzzerState(snapshot.buzzer, !buzzerInitialized);
  orderingState = snapshot.ordering;
  listingState = snapshot.listing;
  syncState = snapshot.sync;
  receiveTeamLobbyState(snapshot.teamLobby);
  if (!displayScoreAnimationActive) render();
}

function syncGameEventSource() {
  if (usePollingTransport) return;
  const nextScreen = ["jeopardy-board", "jeopardy-question"].includes(presentation?.screen)
    ? "jeopardy"
    : ["team-lobby", "ordering", "listing", "sync"].includes(presentation?.screen) ? presentation.screen : null;
  if (nextScreen === activeGameEventScreen) return;
  activeGameEventSource?.close();
  activeGameEventSource = null;
  activeGameEventScreen = nextScreen;
  if (nextScreen === "team-lobby") {
    activeGameEventSource = new EventSource("/api/team-lobby/events?role=public");
    activeGameEventSource.addEventListener("state", (event) => {
      receiveTeamLobbyState(JSON.parse(event.data));
      if (!displayScoreAnimationActive) render();
    });
  } else if (nextScreen === "jeopardy") {
    activeGameEventSource = new EventSource("/api/buzzer/events");
    activeGameEventSource.addEventListener("state", (event) => {
      receiveBuzzerState(JSON.parse(event.data));
    });
  } else if (nextScreen === "ordering") {
    activeGameEventSource = new EventSource("/api/ordering/events?role=public");
    activeGameEventSource.addEventListener("state", (event) => {
      orderingState = JSON.parse(event.data);
      if (!displayScoreAnimationActive) render();
    });
  } else if (nextScreen === "listing") {
    activeGameEventSource = new EventSource("/api/listing/events?role=public");
    activeGameEventSource.addEventListener("state", (event) => {
      listingState = JSON.parse(event.data);
      if (!displayScoreAnimationActive) render();
    });
  } else if (nextScreen === "sync") {
    activeGameEventSource = new EventSource("/api/sync/events?role=public");
    activeGameEventSource.addEventListener("state", (event) => {
      syncState = JSON.parse(event.data);
      if (!displayScoreAnimationActive) render();
    });
  }
}

if (usePollingTransport) {
  startLivePolling({ onSnapshot: receiveLiveSnapshot, onConnectionChange: setDisplayConnection });
} else {
  const presentationEvents = new EventSource("/api/presentation/events");
  presentationEvents.addEventListener("open", () => {
    initialState("/api/presentation/state")
      .then(receivePresentation)
      .then(() => setDisplayConnection(true))
      .catch(() => setDisplayConnection(false));
  });
  presentationEvents.addEventListener("state", (event) => {
    receivePresentation(JSON.parse(event.data));
    setDisplayConnection(true);
  });
  presentationEvents.addEventListener("error", () => setDisplayConnection(false));

}

if (!usePollingTransport) Promise.all([
  initialState("/api/presentation/state"),
  initialState("/api/buzzer/state"),
  initialState("/api/ordering/state?role=public"),
  initialState("/api/listing/state?role=public"),
  initialState("/api/sync/state?role=public")
])
  .then(([nextPresentation, nextBuzzer, nextOrdering, nextListing, nextSync]) => {
    receivePresentation(nextPresentation);
    if (!buzzer || nextBuzzer.version >= buzzer.version) receiveBuzzerState(nextBuzzer, !buzzerInitialized);
    orderingState = nextOrdering;
    listingState = nextListing;
    syncState = nextSync;
    if (!displayScoreAnimationActive) render();
  })
  .catch(() => {
    connection.textContent = "Warten auf die Quiz-Spielleitung…";
    connection.classList.remove("connected");
  });

orderingTicker = setInterval(() => {
  const timer = root.querySelector(".display-ordering-timer");
  if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
}, 200);

listingTicker = setInterval(() => {
  const timer = root.querySelector(".display-listing-timer");
  if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
}, 200);

syncTicker = setInterval(() => {
  const timer = root.querySelector(".sync-host-timer[data-deadline]");
  if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
}, 100);

window.addEventListener("resize", () => {
  const board = root.querySelector(".display-board");
  if (board && presentation?.board) fitBoard(board, presentation.board.categories.length, presentation.board.values.length);
  scheduleTextFit(root.querySelector(".display-warmup"), ".display-warmup-question");
  root.querySelectorAll(".display-listing-item").forEach((card) => {
    scheduleTextFit(card, ".display-listing-item-text");
  });
});
