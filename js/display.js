const root = document.querySelector("#display-root");
const connection = document.querySelector("#display-connection");
let presentation = null;
let buzzer = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMedia(container, text, image) {
  if (typeof text === "string" && text.trim()) container.append(element("div", "", text));
  if (image) {
    const picture = document.createElement("img");
    picture.src = image.src;
    picture.alt = image.alt;
    picture.addEventListener("error", () => picture.replaceWith(element("div", "", "Image unavailable")), { once: true });
    container.append(picture);
  }
}

function scoreboard(teams) {
  const board = element("aside", "display-scoreboard");
  board.setAttribute("aria-label", "Team scores");
  teams.forEach((team) => {
    const rank = 1 + teams.filter((candidate) => candidate.score > team.score).length;
    const card = element("section", `display-team rank-${rank}`);
    card.append(element("div", "display-team-name", team.name), element("div", "display-team-score", team.score.toLocaleString()));
    board.append(card);
  });
  return board;
}

function standby() {
  const screen = element("section", "display-screen display-standby");
  const content = element("div");
  content.append(element("h1", "", presentation.title), element("p", "", "Waiting for the next game"));
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
  const question = element("div", "display-media");
  renderMedia(question, presentation.question.question, presentation.question.questionImage);
  content.append(question);
  if (presentation.question.answerRevealed) {
    const answer = element("div", "display-media answer");
    renderMedia(answer, presentation.question.answer, presentation.question.answerImage);
    content.append(answer);
  }
  const buzzOrder = element("aside", "display-buzz-order");
  buzzOrder.setAttribute("aria-label", "Buzz order");
  buzzOrder.append(element("strong", "display-buzz-label", "Buzz order"), element("ol", "display-buzz-list"));
  screen.append(content, buzzOrder);
  return screen;
}

function ordering() {
  const screen = element("section", "display-screen display-ordering");
  const content = element("div");
  content.append(element("h1", "", "Put It in Order"), element("p", "", "Get ready for the next challenge."));
  screen.append(content);
  return screen;
}

function victory() {
  const screen = element("section", "display-screen display-victory");
  screen.append(element("h1", "", "Final standings"));
  const standings = element("div", "display-standing-reveals");
  const podium = element("div", "display-podium");
  presentation.steps.forEach((step, index) => {
    if (step.kind === "standing") {
      const row = element("div", `display-standing${index < presentation.revealedCount ? " revealed" : ""}`);
      row.append(document.createTextNode(`Place ${step.rank}: ${step.names} `), element("span", "display-standing-score", `${step.score.toLocaleString()} points`));
      standings.append(row);
    } else {
      const place = element("section", `display-podium-place rank-${step.rank}${index < presentation.revealedCount ? " revealed" : ""}`);
      place.append(
        element("div", "display-podium-rank", String(step.rank)),
        element("div", "display-podium-names", step.names),
        element("div", "display-podium-score", `${step.score.toLocaleString()} points`)
      );
      podium.append(place);
    }
  });
  screen.append(standings, podium);
  return screen;
}

function render() {
  if (!presentation) return;
  document.title = `${presentation.title} — Audience Display`;
  document.body.classList.toggle("with-scoreboard", ["jeopardy-board", "jeopardy-question", "ordering"].includes(presentation.screen));
  const renderers = {
    standby,
    "jeopardy-board": jeopardyBoard,
    "jeopardy-question": jeopardyQuestion,
    ordering,
    victory
  };
  root.replaceChildren(renderers[presentation.screen]());
  if (document.body.classList.contains("with-scoreboard")) root.append(scoreboard(presentation.teams));
  updateBuzzerBanner();
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
  presentation = JSON.parse(event.data);
  connection.textContent = "Connected";
  connection.classList.add("connected");
  render();
});
presentationEvents.addEventListener("error", () => {
  connection.textContent = "Reconnecting to host…";
  connection.classList.remove("connected");
});

const buzzerEvents = new EventSource("/api/buzzer/events");
buzzerEvents.addEventListener("state", (event) => {
  buzzer = JSON.parse(event.data);
  updateBuzzerBanner();
});

Promise.all([initialState("/api/presentation/state"), initialState("/api/buzzer/state")])
  .then(([nextPresentation, nextBuzzer]) => {
    if (!presentation || nextPresentation.version >= presentation.version) presentation = nextPresentation;
    if (!buzzer || nextBuzzer.version >= buzzer.version) buzzer = nextBuzzer;
    render();
  })
  .catch(() => {
    connection.textContent = "Waiting for the quiz host…";
    connection.classList.remove("connected");
  });

window.addEventListener("resize", () => {
  const board = root.querySelector(".display-board");
  if (board && presentation?.board) fitBoard(board, presentation.board.categories.length, presentation.board.values.length);
});
