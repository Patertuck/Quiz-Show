import { animateScoreDistribution } from "./display-score-animation.js";
import { applyTeamColor } from "./team-colors.js";
import { gameDefinition } from "./game-catalog.js";
import qrcode from "../assets/vendor/qrcode.js";
import { scheduleTextFit } from "./fit-text.js";
import { formatInteger } from "./format-number.js";
import { createScoreHistoryChart } from "./score-history-chart.js";
import { element, retryingLogo } from "./display/dom.js";
import { connectDisplaySession } from "./display/live-session.js";
import {
  displaySceneKey,
  gameTransitionPlan,
  jeopardyTransitionPlan,
  manualScoreChanges,
  scoreChanges as calculateScoreChanges
} from "./display/scene.js";
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
} from "./display-sounds.js";

const root = document.querySelector("#display-root");
const connection = document.querySelector("#display-connection");
const audioUnlock = document.querySelector("#display-audio-unlock");
const jeopardyAudio = new Audio();
jeopardyAudio.volume = 0.6;
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
let listingTicker;
let syncTicker;
let displayScoreAnimationActive = false;
const SCREEN_TRANSITION_DURATION_MS = 320;
const GAME_TRANSITION_DURATION_MS = 450;
const JEOPARDY_TRANSITION_DURATION_MS = 900;
let lastRenderedSceneKey = null;
let lastRenderedScreen = null;
let lastRenderedQuestionId = null;
let activeScreenTransition = null;
let activeGameTransition = null;
let activeJeopardyAnimation = null;
let fallbackTransitionTimer;
const presentationQueue = [];
const animatedOrderingRounds = new Set();
const animatedListingRounds = new Set();
const animatedSyncRounds = new Set();
const logoImage = retryingLogo;

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
    applyTeamColor(card, team.color, teamIndex);
    card.append(element("div", "display-team-name", team.name), element("div", "display-team-score", formatInteger(team.score)));
    board.append(card);
  });
  return board;
}

function standby() {
  const screen = element("section", "display-screen display-standby");
  const ambient = element("div", "display-standby-ambient");
  ambient.setAttribute("aria-hidden", "true");
  ambient.append(
    element("div", "display-standby-rays"),
    element("div", "display-standby-halo")
  );
  const sparkles = element("div", "display-standby-sparkles");
  [
    ["12%", "18%", ".75rem", "-1s"], ["83%", "15%", ".55rem", "-4s"],
    ["91%", "48%", ".85rem", "-2.5s"], ["79%", "83%", ".65rem", "-5.5s"],
    ["18%", "80%", ".5rem", "-3s"], ["7%", "54%", ".7rem", "-6s"]
  ].forEach(([left, top, size, delay]) => {
    const sparkle = document.createElement("i");
    sparkle.style.setProperty("--sparkle-left", left);
    sparkle.style.setProperty("--sparkle-top", top);
    sparkle.style.setProperty("--sparkle-size", size);
    sparkle.style.setProperty("--sparkle-delay", delay);
    sparkles.append(sparkle);
  });
  ambient.append(sparkles);
  const content = element("div", "display-standby-content");
  const stage = element("div", "display-standby-logo-stage");
  stage.append(logoImage("display-standby-logo", presentation.logos.main));
  content.append(stage);
  screen.append(ambient, content);
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
    teamLobbyState.teams.forEach((team, index) => {
      const card = element("section", "display-team-lobby-team");
      applyTeamColor(card, team.color, index);
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

function hub() {
  const screen = element("section", "display-screen display-hub");
  screen.append(element("h1", "", presentation.title));
  const area = element("div", "display-hub-game-area");
  const games = element("div", "display-hub-games");
  const availableGames = presentation.games.map((id) => gameDefinition(id, presentation.logos));
  games.style.setProperty("--game-count", availableGames.length);
  games.style.setProperty("--game-width", `${availableGames.length * 100}cqh`);
  games.style.setProperty("--game-max-width", `${availableGames.length * 24}rem`);
  availableGames.forEach((game) => {
    const card = element("div", `display-hub-game${presentation.highlightedGame === game.id ? " highlighted" : ""}`);
    card.dataset.game = game.id;
    const image = element("img");
    image.src = game.logo;
    image.alt = game.label;
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
  const { categories, values, usedTiles, highlightedTile } = presentation.board;
  const used = new Set(usedTiles);
  board.style.gridTemplateColumns = `repeat(${categories.length}, minmax(0, 1fr))`;
  board.style.gridTemplateRows = `minmax(0, 1.1fr) repeat(${values.length}, minmax(0, 1fr))`;
  categories.forEach((category) => board.append(element("div", "display-category", category)));
  values.forEach((value, row) => categories.forEach((_, category) => {
    const tileId = `${category}:${row}`;
    const tile = element(
      "div",
      `display-tile${used.has(tileId) ? " used" : ""}${highlightedTile === tileId ? " highlighted" : ""}`,
      formatInteger(value)
    );
    tile.dataset.tileId = tileId;
    board.append(tile);
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
    `±${formatInteger(presentation.question.value)} Punkte`
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

function orderingScoringExample(example) {
  const relative = example.scoringMode === "relative";
  const screen = element("section", "display-screen display-ordering-example");
  const content = element("div", "display-ordering-example-card");
  const heading = element("header", "display-ordering-example-heading");
  heading.append(
    element("span", "display-ordering-example-kicker", "ORDER UP · WERTUNGSBEISPIEL"),
    element("h1", "", "Alter – älteste Person zuerst"),
    element("p", "", relative
      ? "Jedes Personenpaar wird miteinander verglichen."
      : "Nur die exakt richtige Position zählt.")
  );

  const rows = element("div", "display-ordering-example-rows");
  const row = (label, values, attempt = false) => {
    const section = element("section", `display-ordering-example-row${attempt ? " attempt" : " correct"}`);
    section.append(element("h2", "", label));
    const cards = element("div", "display-ordering-example-cards");
    values.forEach(({ name, age }, index) => {
      const card = element("div", "display-ordering-example-person");
      if (attempt && !relative) card.classList.add(index === 0 ? "match" : "miss");
      card.append(element("strong", "", name), element("span", "", `${age} Jahre`));
      cards.append(card);
    });
    section.append(cards);
    return section;
  };
  rows.append(
    row("Richtige Reihenfolge", [
      { name: "Anna", age: 40 }, { name: "Ben", age: 30 }, { name: "Clara", age: 20 }
    ]),
    row("Reihenfolge des Teams", [
      { name: "Anna", age: 40 }, { name: "Clara", age: 20 }, { name: "Ben", age: 30 }
    ], true)
  );

  const evaluation = element("div", "display-ordering-example-evaluation");
  if (relative) {
    [["Anna vor Ben", true], ["Anna vor Clara", true], ["Ben vor Clara", false]].forEach(([label, correct]) => {
      evaluation.append(element("span", `display-ordering-example-check ${correct ? "correct" : "wrong"}`, `${correct ? "✓" : "✕"} ${label}`));
    });
  } else {
    evaluation.append(
      element("span", "display-ordering-example-check correct", "✓ Anna: Position 1"),
      element("span", "display-ordering-example-check wrong", "✕ Clara: Position 2"),
      element("span", "display-ordering-example-check wrong", "✕ Ben: Position 3")
    );
  }
  const correctCount = relative ? 2 : 1;
  const total = 3;
  const result = element("strong", "display-ordering-example-result",
    `${correctCount} von ${total} ${relative ? "Paaren" : "Positionen"} richtig  ×  ${formatInteger(example.pointsPerCorrect)}  =  ${formatInteger(correctCount * example.pointsPerCorrect)} Punkte`);
  content.append(heading, rows, evaluation, result);
  screen.append(content);
  return screen;
}

function rulesExampleShell(gameId, kicker, title, subtitle) {
  const screen = element("section", `display-screen display-rules-example display-rules-example-${gameId}`);
  const card = element("div", "display-rules-example-card");
  const heading = element("header", "display-rules-example-heading");
  heading.append(
    element("span", "display-rules-example-kicker", kicker),
    element("h1", "", title),
    element("p", "", subtitle)
  );
  card.append(heading);
  screen.append(card);
  return { screen, card };
}

function jeopardyRulesExample(example) {
  const { screen, card } = rulesExampleShell(
    "jeopardy", "JEOPARDY · BEISPIEL", "Allgemeinwissen", "So laufen Frage, Buzzer und Wertung ab."
  );
  const flow = element("div", "display-rules-example-flow jeopardy");
  const tile = element("section", "display-rules-example-block tile");
  tile.append(element("small", "", "Gewähltes Feld"), element("strong", "", formatInteger(example.value)));
  const question = element("section", "display-rules-example-block question");
  question.append(element("small", "", "Frage"), element("strong", "", "Wie viele Minuten hat eine Stunde?"));
  const answer = element("section", "display-rules-example-block answer");
  answer.append(element("small", "", "BUZZ · Antwort"), element("strong", "", "60 Minuten"));
  flow.append(tile, element("span", "display-rules-example-arrow", "→"), question, element("span", "display-rules-example-arrow", "→"), answer);
  const results = element("div", "display-rules-example-results");
  results.append(
    element("strong", "correct", `Richtig: +${formatInteger(example.value)}`),
    element("strong", "wrong", `Falsch: −${formatInteger(example.value)}`)
  );
  card.append(flow, results);
  return screen;
}

function listingRulesExample(example) {
  const { screen, card } = rulesExampleShell(
    "listing", "LIST IT · BEISPIEL", "Nennt Obstsorten", "Doppelte und ungültige Antworten bringen keinen zusätzlichen Treffer."
  );
  const answers = element("div", "display-rules-example-answers");
  [["Apfel", "correct", "gültig"], ["Birne", "correct", "gültig"], ["Apfel", "duplicate", "doppelt"], ["Auto", "wrong", "ungültig"]]
    .forEach(([answer, status, label]) => {
      const item = element("div", `display-rules-example-answer ${status}`);
      item.append(element("strong", "", answer), element("span", "", label));
      answers.append(item);
    });
  const summary = element("strong", "display-rules-example-summary", "2 gültige Begriffe");
  const podium = element("div", "display-rules-example-podium");
  example.placementPoints.forEach((points, index) => {
    const place = element("div", `place-${index + 1}`);
    place.append(element("span", "", `${index + 1}. Platz`), element("strong", "", `+${formatInteger(points)}`));
    podium.append(place);
  });
  card.append(answers, summary, podium);
  return screen;
}

function syncRulesExample(example) {
  const { screen, card } = rulesExampleShell(
    "sync", "SYNC UP · BEISPIEL", "Wer organisiert am ehesten einen Quizabend?", "Alle wählen heimlich eine Person aus dem eigenen Team."
  );
  const votes = element("div", "display-rules-example-votes");
  ["Lea", "Noah", "Mia"].forEach((name) => {
    const vote = element("section", "display-rules-example-vote");
    vote.append(element("span", "", name), element("strong", "", "Lea"));
    votes.append(vote);
  });
  const result = element("div", "display-rules-example-sync-result");
  result.append(
    element("span", "", "3 von 3 wählen Lea"),
    element("strong", "", `Kompletter Sync: +${formatInteger(example.pointsPerSync)} Punkte`)
  );
  card.append(votes, result);
  return screen;
}

function rulesExample() {
  const example = presentation.example;
  if (example.gameId === "ordering") return orderingScoringExample(example);
  if (example.gameId === "jeopardy") return jeopardyRulesExample(example);
  if (example.gameId === "listing") return listingRulesExample(example);
  return syncRulesExample(example);
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
    title.append(element("span", "", name), element("strong", "", round.pointsRevealed ? `+${formatInteger(round.roundPoints[teamIndex])}` : ""));
    column.append(title);
    round.teamOrders[teamIndex].forEach((id, slot) => {
      const revealed = round.revealed.includes(slot);
      const correct = revealed && id === round.revealedItems[slot]?.id;
      const resultClass = revealed
        ? round.scoringMode === "relative" ? " relative-revealed" : correct ? " correct" : " wrong"
        : "";
      const cell = element("div", `display-ordering-cell${resultClass}`);
      cell.append(element("span", "display-ordering-cell-text", itemNames.get(id)));
      if (revealed && round.scoringMode === "relative" && round.pointsRevealed) {
        const value = round.rowPoints[teamIndex][slot];
        cell.append(element(
          "strong",
          `display-ordering-row-points${value === 0 ? " zero" : ""}${round.phase === "distributed" ? " settled" : ""}`,
          `+${formatInteger(value)}`
        ));
      }
      column.append(cell);
    });
    (teamIndex < split ? left : right).append(column);
  });
  const solution = element("section", "display-ordering-column display-ordering-solution");
  solution.style.setProperty("--ordering-count", round.revealedItems.length);
  solution.append(element("h2", "", "Richtige Reihenfolge"));
  round.revealedItems.forEach((item, slot) => {
    const cell = element("div", `display-ordering-cell${item ? " revealed" : " hidden-answer"}`);
    cell.append(element("span", "display-ordering-cell-text", item?.text || `Antwort ${slot + 1}`));
    solution.append(cell);
  });
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
    board.querySelectorAll(".display-ordering-cell").forEach((cell) => {
      scheduleTextFit(cell, ".display-ordering-cell-text", { maxHeightRatio: 0.28 });
    });
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
  if (round.phase === "review" && round.review) {
    const content = element("div", "display-listing-review");
    const points = round.review.items.reduce((total, item) => total + (item.decision === 1 ? 1 : item.decision === -1 ? -1 : 0), 0);
    const header = element("header", "display-listing-review-header");
    const title = element("div", "");
    title.append(
      element("p", "display-listing-review-progress", `Team ${round.review.teamPosition + 1} von ${round.review.teamTotal}`),
      element("h1", "display-listing-team", listingState.teams[round.review.teamIndex])
    );
    const score = element("strong", "display-listing-review-count");
    score.setAttribute("aria-label", `${points} gültige Begriffe`);
    score.append(
      element("span", "display-listing-review-count-value", String(points)),
      element("span", "display-listing-review-count-label", "gültig")
    );
    header.append(title, score);
    const answers = element("div", "display-listing-review-grid");
    round.review.items.forEach((item) => {
      let state = "pending";
      if (item.decision === 1 || item.decision === true) state = "positive";
      else if (item.decision === -1) state = "negative";
      else if (item.decision === 0 || item.decision === false) state = "neutral";
      const card = element("article", `display-listing-review-item decision-${state}`);
      card.append(element("span", "display-listing-review-answer", item.text));
      answers.append(card);
    });
    content.append(header, answers);
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
      element("strong", "display-listing-points", `+${formatInteger(result.points)}`)
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
  if (presentation.screen === "jeopardy-question"
      && (presentation.question?.questionAudio || presentation.question?.answerAudio)) return "silent";
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
    syncState?.syncTeams.forEach((team) => {
      const card = element("section", "sync-roster-team");
      card.append(element("h2", "", team.name));
      const members = syncState.participants.filter((person) => person.syncTeamId === team.id);
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
    card.dataset.syncTeamId = result.syncTeamId;
    card.append(
      element("h2", "", syncState.syncTeams.find((team) => team.id === result.syncTeamId)?.name || "?"),
      element("strong", "sync-result-points", `+${formatInteger(result.points)}`)
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
  const winnerIndex = presentation.steps.findIndex((step) => step.kind === "podium" && step.rank === 1);
  if (winnerIndex >= 0 && presentation.revealedCount > winnerIndex) {
    const confetti = element("div", "display-confetti");
    confetti.setAttribute("aria-hidden", "true");
    confetti.append(...Array.from({ length: 100 }, (_, index) => {
      const piece = element("i", "display-confetti-piece");
      const duration = 2400 + Math.random() * 1800;
      piece.style.setProperty("--confetti-left", `${Math.random() * 100}%`);
      piece.style.setProperty("--confetti-size", `${6 + Math.random() * 8}px`);
      piece.style.setProperty("--confetti-hue", String((index * 43) % 360));
      piece.style.setProperty("--confetti-drift", `${-18 + Math.random() * 36}vw`);
      piece.style.setProperty("--confetti-delay", `${Math.random() * duration}ms`);
      piece.style.setProperty("--confetti-duration", `${duration}ms`);
      return piece;
    }));
    screen.append(confetti);
  }
  screen.append(element("h1", "", "Endstand"));
  const standings = element("div", "display-standing-reveals");
  const podium = element("div", "display-podium");
  presentation.steps.forEach((step, index) => {
    if (step.kind === "standing") {
      const row = element("div", `display-standing${index < presentation.revealedCount ? " revealed" : ""}`);
      row.append(document.createTextNode(`Platz ${step.rank}: ${step.names} `), element("span", "display-standing-score", `${formatInteger(step.score)} Punkte`));
      standings.append(row);
    } else {
      const place = element("section", `display-podium-place rank-${step.rank}${index < presentation.revealedCount ? " revealed" : ""}`);
      place.append(
        element("div", "display-podium-rank", String(step.rank)),
        element("div", "display-podium-names", step.names),
        element("div", "display-podium-score", `${formatInteger(step.score)} Punkte`)
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
  return displaySceneKey(presentation, { ordering: orderingState, listing: listingState, sync: syncState });
}

function renderImmediately() {
  if (!presentation) return;
  document.title = `${presentation.title} — Publikumsansicht`;
  document.body.classList.toggle("with-scoreboard", ["hub", "jeopardy-board", "jeopardy-question", "ordering", "listing", "sync", "rules-example"].includes(presentation.screen));
  const renderers = {
    standby,
    "team-lobby": teamLobby,
    hub,
    "jeopardy-board": jeopardyBoard,
    "jeopardy-question": jeopardyQuestion,
    ordering,
    listing,
    sync,
    "rules-example": rulesExample,
    victory,
    "score-history": scoreHistory
  };
  root.replaceChildren(renderers[presentation.screen]());
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
  lastRenderedScreen = presentation.screen;
  lastRenderedQuestionId = presentation.screen === "jeopardy-question" ? presentation.question?.id : null;
}

function displayTile(tileId) {
  return Array.from(root.querySelectorAll(".display-tile")).find((tile) => tile.dataset.tileId === tileId) || null;
}

function displayGameLogo(gameId) {
  return Array.from(root.querySelectorAll(".display-hub-game")).find((card) => card.dataset.game === gameId)
    ?.querySelector("img") || null;
}

function transitionOverlay(source) {
  const bounds = source.getBoundingClientRect();
  const overlay = source.cloneNode(true);
  overlay.classList.add("jeopardy-transition-overlay");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    top: `${bounds.top}px`,
    left: `${bounds.left}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`
  });
  return { bounds, overlay };
}

function cancelJeopardyAnimation() {
  activeJeopardyAnimation?.cancel();
  activeJeopardyAnimation = null;
  document.querySelectorAll(".jeopardy-transition-overlay").forEach((overlay) => overlay.remove());
  root.querySelectorAll(".jeopardy-transition-target").forEach((target) => {
    target.classList.remove("jeopardy-transition-target");
  });
}

function cancelGameTransition() {
  activeGameTransition?.animations.forEach((animation) => animation.cancel());
  activeGameTransition = null;
  document.querySelectorAll(".game-transition-overlay").forEach((overlay) => overlay.remove());
  root.querySelectorAll(".game-transition-target").forEach((target) => {
    target.classList.remove("game-transition-target");
    target.style.removeProperty("opacity");
  });
}

function finishGameTransition(transition) {
  if (activeGameTransition !== transition) return;
  activeGameTransition = null;
  transition.animations.forEach((animation) => animation.cancel());
  transition.nodes.forEach((node) => node.remove());
  transition.target?.classList.remove("game-transition-target");
  transition.target?.style.removeProperty("opacity");
}

function runGameTransition(plan) {
  cancelGameTransition();
  const opening = plan.direction === "opening";
  const sourceLogo = opening ? displayGameLogo(plan.gameId) : null;
  const sourceScreen = root.querySelector(".display-screen");
  if (!sourceScreen || (opening && !sourceLogo)) {
    renderImmediately();
    return;
  }

  const sourceScreenOverlay = transitionOverlay(sourceScreen).overlay;
  const sourceLogoOverlay = sourceLogo ? transitionOverlay(sourceLogo).overlay : null;
  renderImmediately();
  const targetScreen = root.querySelector(".display-screen");
  const targetLogo = opening ? null : displayGameLogo(plan.gameId);
  if (!targetScreen || (!opening && !targetLogo)) {
    sourceScreenOverlay.remove();
    sourceLogoOverlay?.remove();
    return;
  }

  sourceScreenOverlay.classList.add("game-transition-overlay", "game-transition-backdrop");
  if (opening) {
    const backdropLogo = Array.from(sourceScreenOverlay.querySelectorAll(".display-hub-game"))
      .find((card) => card.dataset.game === plan.gameId)?.querySelector("img");
    if (backdropLogo) backdropLogo.style.opacity = "0";
  }
  document.body.append(sourceScreenOverlay);
  const animations = [];
  const nodes = [sourceScreenOverlay];
  targetScreen.classList.add("game-transition-target");

  if (opening) {
    sourceLogoOverlay.classList.add("game-transition-overlay", "game-transition-logo");
    document.body.append(sourceLogoOverlay);
    nodes.push(sourceLogoOverlay);
    animations.push(sourceLogoOverlay.animate([
      { transform: "none", opacity: 1 },
      { transform: "scale(1.09)", opacity: 1, offset: .46 },
      { transform: "scale(1.1)", opacity: 0 }
    ], { duration: GAME_TRANSITION_DURATION_MS, easing: "cubic-bezier(.22,.72,.2,1)", fill: "both" }));
    animations.push(sourceScreenOverlay.animate([
      { opacity: 1 }, { opacity: .78, offset: .32 }, { opacity: 0 }
    ], { duration: GAME_TRANSITION_DURATION_MS, easing: "ease-out", fill: "both" }));
    animations.push(targetScreen.animate([
      { opacity: 0, transform: "scale(1.015)" },
      { opacity: 1, transform: "scale(1)" }
    ], { duration: GAME_TRANSITION_DURATION_MS, easing: "ease-out", fill: "both" }));
  } else {
    animations.push(targetLogo.animate([
      { transform: "scale(1.1)", opacity: .25 },
      { transform: "scale(1)", opacity: 1 }
    ], { duration: GAME_TRANSITION_DURATION_MS, easing: "cubic-bezier(.22,.72,.2,1)", fill: "both" }));
    animations.push(sourceScreenOverlay.animate([
      { opacity: 1 }, { opacity: 0 }
    ], { duration: GAME_TRANSITION_DURATION_MS, easing: "ease-out", fill: "both" }));
    animations.push(targetScreen.animate([
      { opacity: 0, transform: "scale(.99)" },
      { opacity: 1, transform: "scale(1)" }
    ], { duration: GAME_TRANSITION_DURATION_MS, easing: "ease-out", fill: "both" }));
  }

  const transition = { animations, nodes, target: targetScreen };
  activeGameTransition = transition;
  Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
    .finally(() => finishGameTransition(transition));
}

function runJeopardyTransition(plan) {
  cancelJeopardyAnimation();
  const source = plan.direction === "opening" ? displayTile(plan.tileId) : root.querySelector(".display-question");
  if (!source || !plan.tileId) {
    renderImmediately();
    return;
  }

  const sourceBounds = source.getBoundingClientRect();
  const overlaySource = plan.direction === "opening" ? root.querySelector(".display-board-screen") : source;
  const { overlay } = transitionOverlay(overlaySource);
  renderImmediately();
  const target = plan.direction === "opening" ? root.querySelector(".display-question") : displayTile(plan.tileId);
  if (!target) return;
  const targetBounds = target.getBoundingClientRect();

  if (plan.direction === "opening") {
    const backdrop = overlay;
    backdrop.classList.add("jeopardy-transition-backdrop");
    document.body.append(backdrop);
    target.classList.add("jeopardy-transition-target");
    const dx = sourceBounds.left - targetBounds.left;
    const dy = sourceBounds.top - targetBounds.top;
    const scaleX = sourceBounds.width / targetBounds.width;
    const scaleY = sourceBounds.height / targetBounds.height;
    activeJeopardyAnimation = target.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, borderRadius: ".15rem" },
      { transform: "none", borderRadius: "0" }
    ], { duration: JEOPARDY_TRANSITION_DURATION_MS, easing: "cubic-bezier(.2,.78,.18,1)", fill: "both" });
  } else {
    document.body.append(overlay);
    const dx = targetBounds.left - sourceBounds.left;
    const dy = targetBounds.top - sourceBounds.top;
    const scaleX = targetBounds.width / sourceBounds.width;
    const scaleY = targetBounds.height / sourceBounds.height;
    activeJeopardyAnimation = overlay.animate([
      { transform: "none", opacity: 1, borderRadius: "0" },
      { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, opacity: .35, borderRadius: ".15rem" }
    ], { duration: JEOPARDY_TRANSITION_DURATION_MS, easing: "cubic-bezier(.2,.78,.18,1)", fill: "both" });
  }

  const animation = activeJeopardyAnimation;
  animation.finished.catch(() => undefined).finally(() => {
    if (activeJeopardyAnimation !== animation) return;
    activeJeopardyAnimation = null;
    overlay.remove();
    target.classList.remove("jeopardy-transition-target");
  });
}

function render() {
  if (!presentation) return;
  syncDisplayBackgroundMusic();
  const nextSceneKey = sceneKey();
  const shouldAnimate = lastRenderedSceneKey !== null
    && nextSceneKey !== lastRenderedSceneKey;
  lastRenderedSceneKey = nextSceneKey;

  if (!shouldAnimate) {
    renderImmediately();
    return;
  }

  const gamePlan = gameTransitionPlan(lastRenderedScreen, presentation.screen);
  if (gamePlan) {
    cancelJeopardyAnimation();
    activeScreenTransition?.skipTransition();
    activeScreenTransition = null;
    runGameTransition(gamePlan);
    return;
  }

  const jeopardyPlan = jeopardyTransitionPlan(lastRenderedScreen, lastRenderedQuestionId, presentation);
  if (jeopardyPlan) {
    cancelGameTransition();
    activeScreenTransition?.skipTransition();
    activeScreenTransition = null;
    runJeopardyTransition(jeopardyPlan);
    return;
  }

  if (typeof document.startViewTransition === "function") {
    cancelGameTransition();
    cancelJeopardyAnimation();
    activeScreenTransition?.skipTransition();
    const transition = document.startViewTransition(renderImmediately);
    activeScreenTransition = transition;
    transition.finished.finally(() => {
      if (activeScreenTransition === transition) {
        activeScreenTransition = null;
      }
    });
    return;
  }

  cancelGameTransition();
  cancelJeopardyAnimation();
  renderImmediately();
  clearTimeout(fallbackTransitionTimer);
  root.querySelectorAll(":scope > *").forEach((node) => node.classList.add("display-transition-enter"));
  fallbackTransitionTimer = setTimeout(() => {
    root.querySelectorAll(".display-transition-enter").forEach((node) => node.classList.remove("display-transition-enter"));
  }, SCREEN_TRANSITION_DURATION_MS);
}

function scoreChanges(nextPresentation) {
  return calculateScoreChanges(presentation, nextPresentation);
}

function manualScoreAnimationPlan(nextPresentation) {
  const awards = manualScoreChanges(presentation, nextPresentation);
  return awards.length ? { awards, origins: [] } : null;
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
  const resultBySyncTeam = new Map(round.results.map((result) => [result.syncTeamId, result]));
  const expectedPoints = new Map();
  syncState.syncTeams.forEach((team) => team.quizTeamIndices.forEach((teamIndex) => {
    expectedPoints.set(teamIndex, resultBySyncTeam.get(team.id)?.points || 0);
  }));
  const awards = scoreChanges(nextPresentation);
  if (!awards.some(({ points }) => points > 0)
      || awards.some(({ points, teamIndex }) => points !== (expectedPoints.get(teamIndex) || 0))) return null;
  const origins = awards.map(({ teamIndex }) => {
    const syncTeam = syncState.syncTeams.find((team) => team.quizTeamIndices.includes(teamIndex));
    return root.querySelector(
      `.sync-result-team[data-sync-team-id="${syncTeam?.id}"] .sync-result-points`
    )?.getBoundingClientRect() || null;
  });
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
  return manualScoreAnimationPlan(nextPresentation)
    || jeopardyAnimationPlan(nextPresentation)
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
      && latest?.version !== undefined && nextPresentation.version <= latest.version) return false;
  if (latest?.serverSessionId && latest.serverSessionId !== nextPresentation.serverSessionId) {
    presentationQueue.length = 0;
  }
  presentationQueue.push(nextPresentation);
  drainPresentationQueue().catch((error) => {
    console.error(error);
    presentation = nextPresentation;
    render();
  });
  return true;
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

window.addEventListener("resize", () => {
  scheduleTextFit(root.querySelector(".display-question-content"));
  root.querySelectorAll(".display-ordering-cell").forEach((cell) => {
    scheduleTextFit(cell, ".display-ordering-cell-text", { maxHeightRatio: 0.28 });
  });
});

function setDisplayConnection(connected) {
  connection.textContent = connected ? "Verbunden" : "Verbindung zur Spielleitung wird wiederhergestellt…";
  connection.classList.toggle("connected", connected);
}

function liveGameStateChanged(screen, previous, next) {
  const key = {
    "team-lobby": "teamLobby",
    ordering: "ordering",
    listing: "listing",
    sync: "sync"
  }[screen];
  return Boolean(key) && previous[key]?.version !== next[key]?.version;
}

const liveConnection = connectDisplaySession({
  onConnectionChange: setDisplayConnection,
  onSnapshot: (snapshot) => {
    const previousGameState = { teamLobby: teamLobbyState, ordering: orderingState, listing: listingState, sync: syncState };
    const gameStateChanged = liveGameStateChanged(presentation?.screen, previousGameState, snapshot);
    receiveTeamLobbyState(snapshot.teamLobby);
    orderingState = snapshot.ordering;
    listingState = snapshot.listing;
    syncState = snapshot.sync;
    receiveBuzzerState(snapshot.buzzer, !buzzerInitialized);
    const presentationQueued = receivePresentation(snapshot.presentation);
    if (!presentationQueued && gameStateChanged && !displayScoreAnimationActive) render();
  }
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
});
window.addEventListener("pagehide", () => liveConnection.close());
