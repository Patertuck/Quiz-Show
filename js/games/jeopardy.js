import { state, saveState } from "../store.js";
import { updateScoreControls } from "../scoreboard.js";

export function mount(root) {
  const boardView = root.querySelector("#jeopardy-board-view");
  const questionView = root.querySelector("#jeopardy-question-view");
  const board = root.querySelector("#board");
  const questionContent = root.querySelector("#question-content");
  const answerContent = root.querySelector("#answer-content");
  const revealButton = root.querySelector("#reveal-button");
  root.querySelector("#jeopardy-title").textContent = state.config.title;

  function setTileUsed(tile, used) {
    tile.classList.toggle("used", used);
    tile.setAttribute("aria-disabled", String(used));
    if (used) {
      tile.title = "Right-click to restore this question";
      tile.setAttribute("aria-label", `${tile.dataset.availableLabel}, used. Right-click to restore.`);
    } else {
      tile.removeAttribute("title");
      tile.setAttribute("aria-label", tile.dataset.availableLabel);
    }
  }

  function renderBoard() {
    const { categories, values } = state.config;
    board.replaceChildren();
    board.style.gridTemplateColumns = `repeat(${categories.length}, minmax(0, 1fr))`;
    board.style.gridTemplateRows = `minmax(0, 1.1fr) repeat(${values.length}, minmax(0, 1fr))`;
    categories.forEach((category) => {
      const heading = document.createElement("div");
      heading.className = "category";
      heading.textContent = category.name;
      board.append(heading);
    });
    values.forEach((value, rowIndex) => categories.forEach((category, categoryIndex) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "tile";
      tile.textContent = value.toLocaleString();
      tile.dataset.row = rowIndex;
      tile.dataset.category = categoryIndex;
      tile.dataset.availableLabel = `${category.name} for ${value} points`;
      setTileUsed(tile, state.usedTiles.has(`${categoryIndex}:${rowIndex}`));
      tile.addEventListener("click", () => {
        if (!tile.classList.contains("used")) openQuestion(tile, categoryIndex, rowIndex);
      });
      tile.addEventListener("contextmenu", (event) => {
        if (!tile.classList.contains("used")) return;
        event.preventDefault();
        state.usedTiles.delete(`${categoryIndex}:${rowIndex}`);
        setTileUsed(tile, false);
        saveState().catch(() => undefined);
      });
      board.append(tile);
    }));
  }

  function fitBoard() {
    const width = board.clientWidth;
    const height = board.clientHeight;
    if (!width || !height) return;
    const columnWidth = width / state.config.categories.length;
    const rowHeight = height / (state.config.values.length + 1.1);
    board.style.setProperty("--category-font-size", `${Math.max(6, Math.min(21, columnWidth * 0.15, rowHeight * 0.32))}px`);
    board.style.setProperty("--tile-font-size", `${Math.max(8, Math.min(35, columnWidth * 0.27, rowHeight * 0.48))}px`);
    board.style.setProperty("--board-gap", `${Math.max(1, Math.min(5, columnWidth * 0.02, rowHeight * 0.04))}px`);
    board.style.setProperty("--cell-padding", `${Math.max(1, Math.min(12, columnWidth * 0.05, rowHeight * 0.1))}px`);
  }

  function renderMedia(container, text, image) {
    container.replaceChildren();
    if (typeof text === "string" && text.trim()) {
      const element = document.createElement("div");
      element.textContent = text;
      container.append(element);
    }
    if (image) {
      const element = document.createElement("img");
      element.src = image.src;
      element.alt = image.alt;
      element.addEventListener("error", () => {
        const error = document.createElement("div");
        error.className = "image-error";
        error.textContent = `Could not load image: ${image.src}`;
        element.replaceWith(error);
      }, { once: true });
      container.append(element);
    }
  }

  function displayQuestion() {
    const { categoryIndex, rowIndex, answerRevealed } = state.activeQuestion;
    const item = state.config.categories[categoryIndex].questions[rowIndex];
    renderMedia(questionContent, item.question, item.questionImage);
    renderMedia(answerContent, item.answer, item.answerImage);
    answerContent.hidden = !answerRevealed;
    revealButton.hidden = answerRevealed;
    boardView.hidden = true;
    questionView.hidden = false;
  }

  function openQuestion(tile, categoryIndex, rowIndex) {
    state.activeValue = state.config.values[rowIndex];
    state.activeQuestion = { categoryIndex, rowIndex, answerRevealed: false };
    state.usedTiles.add(`${categoryIndex}:${rowIndex}`);
    setTileUsed(tile, true);
    updateScoreControls();
    displayQuestion();
    saveState().catch(() => undefined);
  }

  revealButton.addEventListener("click", () => {
    answerContent.hidden = false;
    revealButton.hidden = true;
    state.activeQuestion.answerRevealed = true;
    saveState().catch(() => undefined);
  });

  root.querySelector("#continue-button").addEventListener("click", () => {
    state.activeQuestion = null;
    state.activeValue = 0;
    updateScoreControls();
    questionView.hidden = true;
    boardView.hidden = false;
    requestAnimationFrame(fitBoard);
    saveState().catch(() => undefined);
  });

  renderBoard();
  const observer = new ResizeObserver(fitBoard);
  observer.observe(board);
  if (state.activeQuestion) {
    state.activeValue = state.config.values[state.activeQuestion.rowIndex];
    updateScoreControls();
    displayQuestion();
  } else {
    state.activeValue = 0;
    updateScoreControls();
    requestAnimationFrame(fitBoard);
  }
  return () => observer.disconnect();
}
