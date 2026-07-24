const root = document.querySelector("#display-root");
const connection = document.querySelector("#display-connection");
let presentation = null;
let buzzer = null;
let orderingState = null;
let orderingTicker;
let displayScoreAnimationActive = false;
const animatedOrderingRounds = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function logoImage(className) {
  const logo = element("img", className);
  logo.src = "assets/Logo-480.webp";
  logo.srcset = "assets/Logo-480.webp 480w, assets/Logo-1024.webp 1024w";
  logo.sizes = "(orientation: landscape) 58vh, 82vw";
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
    picture.addEventListener("error", () => picture.replaceWith(element("div", "", "Image unavailable")), { once: true });
    container.append(picture);
  }
}

function scoreboard(teams) {
  const board = element("aside", "display-scoreboard");
  board.setAttribute("aria-label", "Team scores");
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
    element("p", "", "Waiting for the next game")
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
  const round = orderingState?.round;
  if (!round) {
    const content = element("div");
    content.append(element("h1", "", "Put It in Order"), element("p", "", "Get ready for the next challenge."));
    screen.append(content);
    return screen;
  }
  if (round.phase === "active") {
    const content = element("div", "display-ordering-active");
    content.append(
      element("h1", "", round.title),
      element("p", "display-ordering-prompt", round.prompt),
      element("output", "display-ordering-timer", String(Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000)))),
      element("p", "display-ordering-connected", `${orderingState.connectedTeamCount} of ${orderingState.teams.length} teams connected`)
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
  solution.append(element("h2", "", "Correct order"));
  round.revealedItems.forEach((item, slot) => solution.append(element("div", `display-ordering-cell${item ? " revealed" : " hidden-answer"}`, item?.text || `Answer ${slot + 1}`)));
  board.append(left, solution, right);
  screen.append(heading, board);
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

function audienceAnimationPlan(nextPresentation) {
  const round = orderingState?.round;
  if (!presentation || presentation.screen !== "ordering" || nextPresentation.screen !== "ordering"
      || !round || animatedOrderingRounds.has(round.id)
      || round.revealed?.length !== round.shuffledItems?.length) return null;
  const awards = nextPresentation.teams.map((team, teamIndex) => ({
    teamIndex,
    points: team.score - (presentation.teams[teamIndex]?.score ?? team.score),
    oldScore: presentation.teams[teamIndex]?.score ?? team.score,
    newScore: team.score
  }));
  if (!awards.some(({ points }) => points > 0)
      || awards.some(({ points, teamIndex }) => points !== (round.roundPoints?.[teamIndex] || 0))) return null;
  const origins = awards.map(({ teamIndex }) => root.querySelector(
    `.display-ordering-column[data-team-index="${teamIndex}"] h2 strong`
  )?.getBoundingClientRect() || null);
  animatedOrderingRounds.add(round.id);
  return { awards, origins };
}

function countDisplayScore(output, from, to, duration = 420) {
  if (!output || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    if (output) output.textContent = to.toLocaleString();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      output.textContent = Math.round(from + ((to - from) * eased)).toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

async function animateDisplayAward(origin, award) {
  const card = root.querySelector(`.display-team[data-team-index="${award.teamIndex}"]`);
  const output = card?.querySelector(".display-team-score");
  if (!card || !output) return;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const destination = output.getBoundingClientRect();
  if (!reducedMotion && origin) {
    const badge = element("div", "display-points-flight", `+${award.points.toLocaleString()}`);
    badge.style.left = `${origin.left + origin.width / 2}px`;
    badge.style.top = `${origin.top + origin.height / 2}px`;
    document.body.append(badge);
    const dx = destination.left + destination.width / 2 - (origin.left + origin.width / 2);
    const dy = destination.top + destination.height / 2 - (origin.top + origin.height / 2);
    await badge.animate([
      { transform: "translate(-50%, -50%) scale(.65)", opacity: 0 },
      { transform: "translate(-50%, -50%) scale(1.16)", opacity: 1, offset: 0.28 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.52 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1 }
    ], { duration: 700, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }).finished.catch(() => undefined);
    await badge.animate([
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.58}px), calc(-50% + ${dy * 0.42 - 55}px)) scale(1.08)`, opacity: 1, offset: 0.48 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.5)`, opacity: 0.2 }
    ], { duration: 320, easing: "cubic-bezier(.35,.05,.7,.2)", fill: "forwards" }).finished.catch(() => undefined);
    badge.remove();
  }
  card.classList.add("points-arrived");
  await countDisplayScore(output, award.oldScore, award.newScore);
  setTimeout(() => card.classList.remove("points-arrived"), 550);
  await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : 120));
}

async function runAudienceAnimation(plan) {
  const moving = plan.awards.filter(({ points }) => points > 0);
  moving.forEach(({ teamIndex, oldScore }) => {
    const output = root.querySelector(`.display-team[data-team-index="${teamIndex}"] .display-team-score`);
    if (output) output.textContent = oldScore.toLocaleString();
  });
  for (const award of moving) await animateDisplayAward(plan.origins[award.teamIndex], award);
}

function receivePresentation(nextPresentation) {
  if (displayScoreAnimationActive) {
    presentation = nextPresentation;
    return;
  }
  const plan = audienceAnimationPlan(nextPresentation);
  presentation = nextPresentation;
  render();
  if (!plan) return;
  displayScoreAnimationActive = true;
  runAudienceAnimation(plan).catch(console.error).finally(() => {
    displayScoreAnimationActive = false;
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
  connection.textContent = "Connected";
  connection.classList.add("connected");
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

const orderingEvents = new EventSource("/api/ordering/events?role=public");
orderingEvents.addEventListener("state", (event) => {
  orderingState = JSON.parse(event.data);
  if (presentation?.screen === "ordering" && !displayScoreAnimationActive) render();
});

Promise.all([initialState("/api/presentation/state"), initialState("/api/buzzer/state"), initialState("/api/ordering/state?role=public")])
  .then(([nextPresentation, nextBuzzer, nextOrdering]) => {
    if (!presentation || nextPresentation.version >= presentation.version) presentation = nextPresentation;
    if (!buzzer || nextBuzzer.version >= buzzer.version) buzzer = nextBuzzer;
    orderingState = nextOrdering;
    if (!displayScoreAnimationActive) render();
  })
  .catch(() => {
    connection.textContent = "Waiting for the quiz host…";
    connection.classList.remove("connected");
  });

orderingTicker = setInterval(() => {
  const timer = root.querySelector(".display-ordering-timer");
  if (timer) timer.textContent = Math.max(0, Math.ceil((Number(timer.dataset.deadline) - Date.now()) / 1000));
}, 200);

window.addEventListener("resize", () => {
  const board = root.querySelector(".display-board");
  if (board && presentation?.board) fitBoard(board, presentation.board.categories.length, presentation.board.values.length);
});
