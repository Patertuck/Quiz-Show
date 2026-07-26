import { animateScoreDistribution } from "./display-score-animation.js";

const root = document.querySelector("#display-root");
const connection = document.querySelector("#display-connection");
let presentation = null;
let buzzer = null;
let orderingState = null;
let listingState = null;
let orderingTicker;
let listingTicker;
let displayScoreAnimationActive = false;
const presentationQueue = [];
const animatedOrderingRounds = new Set();
const animatedListingRounds = new Set();
const standbyLogoSource = "assets/Logo-1024.webp";
const standbyLogoRetryDelay = 2000;

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
  if (typeof text === "string" && text.trim()) container.append(element("div", "", text));
  if (image) {
    const picture = document.createElement("img");
    picture.src = image.src;
    picture.alt = image.alt;
    picture.addEventListener("error", () => picture.replaceWith(element("div", "", "Bild nicht verfügbar")), { once: true });
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
  const question = element("div", "display-media");
  renderMedia(question, presentation.question.question, presentation.question.questionImage);
  content.append(question);
  if (presentation.question.answerRevealed) {
    const answer = element("div", "display-media answer");
    renderMedia(answer, presentation.question.answer, presentation.question.answerImage);
    content.append(answer);
  }
  const buzzOrder = element("aside", "display-buzz-order");
  buzzOrder.setAttribute("aria-label", "Buzzer-Reihenfolge");
  buzzOrder.append(element("strong", "display-buzz-label", "Buzzer-Reihenfolge"), element("ol", "display-buzz-list"));
  screen.append(content, buzzOrder);
  return screen;
}

function ordering() {
  const screen = element("section", "display-screen display-ordering");
  const round = orderingState?.round;
  if (!round) {
    const content = element("div");
    content.append(element("h1", "", "Order Up"), element("p", "", "Macht euch bereit für die nächste Herausforderung."));
    screen.append(content);
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
  screen.append(heading, board);
  return screen;
}

function listing() {
  const screen = element("section", "display-screen display-listing");
  const round = listingState?.round;
  if (!round) {
    const content = element("div", "display-listing-waiting");
    content.append(element("h1", "", "List It"), element("p", "", "Macht euch bereit für die nächste Aufgabe."));
    screen.append(content);
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
        card.textContent = item.text;
        card.title = item.text;
        items.append(card);
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

function render() {
  if (!presentation) return;
  document.title = `${presentation.title} — Publikumsansicht`;
  document.body.classList.toggle("with-scoreboard", ["jeopardy-board", "jeopardy-question", "ordering", "listing"].includes(presentation.screen));
  const renderers = {
    standby,
    "jeopardy-board": jeopardyBoard,
    "jeopardy-question": jeopardyQuestion,
    ordering,
    listing,
    victory
  };
  root.replaceChildren(renderers[presentation.screen]());
  if (document.body.classList.contains("with-scoreboard")) root.append(scoreboard(presentation.teams));
  updateBuzzerBanner();
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
    || listingAnimationPlan(nextPresentation);
}

async function drainPresentationQueue() {
  if (displayScoreAnimationActive) return;
  displayScoreAnimationActive = true;
  try {
    while (presentationQueue.length) {
      const nextPresentation = presentationQueue.shift();
      if (presentation?.version !== undefined && nextPresentation.version <= presentation.version) continue;
      const plan = audienceAnimationPlan(nextPresentation);
      presentation = nextPresentation;
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
  const latestVersion = presentationQueue.at(-1)?.version ?? presentation?.version;
  if (latestVersion !== undefined && nextPresentation.version <= latestVersion) return;
  presentationQueue.push(nextPresentation);
  drainPresentationQueue().catch((error) => {
    console.error(error);
    presentation = nextPresentation;
    render();
  });
}

function updateBuzzerBanner() {
  const order = root.querySelector(".display-buzz-order");
  const list = order?.querySelector(".display-buzz-list");
  const round = buzzer?.round;
  if (!order || !list || !presentation?.question || round?.questionId !== presentation.question.id
      || !round.buzzes.length) {
    if (order) order.hidden = true;
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
}

async function initialState(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const presentationEvents = new EventSource("/api/presentation/events");
presentationEvents.addEventListener("state", (event) => {
  receivePresentation(JSON.parse(event.data));
  connection.textContent = "Verbunden";
  connection.classList.add("connected");
});
presentationEvents.addEventListener("error", () => {
  connection.textContent = "Verbindung zur Spielleitung wird wiederhergestellt…";
  connection.classList.remove("connected");
});

const buzzerEvents = new EventSource("/api/buzzer/events");
buzzerEvents.addEventListener("state", (event) => {
  buzzer = JSON.parse(event.data);
  updateBuzzerBanner();
});

const orderingEvents = new EventSource("/api/ordering/events?role=public");
orderingEvents.addEventListener("state", (event) => {
  orderingState = JSON.parse(event.data);
  if (presentation?.screen === "ordering" && !displayScoreAnimationActive) render();
});

const listingEvents = new EventSource("/api/listing/events?role=public");
listingEvents.addEventListener("state", (event) => {
  listingState = JSON.parse(event.data);
  if (presentation?.screen === "listing" && !displayScoreAnimationActive) render();
});

Promise.all([
  initialState("/api/presentation/state"),
  initialState("/api/buzzer/state"),
  initialState("/api/ordering/state?role=public"),
  initialState("/api/listing/state?role=public")
])
  .then(([nextPresentation, nextBuzzer, nextOrdering, nextListing]) => {
    if (!presentation || nextPresentation.version >= presentation.version) presentation = nextPresentation;
    if (!buzzer || nextBuzzer.version >= buzzer.version) buzzer = nextBuzzer;
    orderingState = nextOrdering;
    listingState = nextListing;
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

window.addEventListener("resize", () => {
  const board = root.querySelector(".display-board");
  if (board && presentation?.board) fitBoard(board, presentation.board.categories.length, presentation.board.values.length);
});
