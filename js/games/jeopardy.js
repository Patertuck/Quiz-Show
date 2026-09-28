import { state, recordAnalyticsEvent, saveState } from "../store.js";
import { updateScoreControls } from "../scoreboard.js";
import { connectToBuzzer, controlBuzzer } from "../buzzer-client.js";
import { commandJeopardyAudio, publishJeopardy } from "../presentation-host.js";
import { scheduleTextFit } from "../fit-text.js";
import { formatInteger } from "../format-number.js";
import { hostFetch } from "../slot-api.js";

export async function mount(root, { showRules } = {}) {
  const boardView = root.querySelector("#jeopardy-board-view");
  const questionView = root.querySelector("#jeopardy-question-view");
  const board = root.querySelector("#board");
  const questionContent = root.querySelector("#question-content");
  const answerContent = root.querySelector("#answer-content");
  const privateSolutionLabel = root.querySelector("#jeopardy-private-solution-label");
  const privateSolutionButton = root.querySelector("#private-solution-button");
  const questionValue = root.querySelector("#question-value");
  const revealButton = root.querySelector("#reveal-button");
  const audioControls = root.querySelector("#audio-controls");
  const audioTracks = root.querySelector("#audio-tracks");
  const audioStatus = root.querySelector("#audio-status");
  const buzzerConnection = root.querySelector("#buzzer-connection");
  const buzzerStatus = root.querySelector("#buzzer-host-status");
  const buzzerPanel = root.querySelector("#buzzer-panel");
  const buzzerActive = root.querySelector("#buzzer-active");
  const buzzerActiveTeam = root.querySelector("#buzzer-active-team");
  const buzzerActiveRemove = root.querySelector("#buzzer-active-remove");
  const buzzerEmpty = root.querySelector("#buzzer-empty");
  const buzzerEmptyDetail = root.querySelector("#buzzer-empty-detail");
  const buzzerQueueCount = root.querySelector("#buzzer-queue-count");
  const buzzOrder = root.querySelector("#buzz-order");
  const buzzerControl = root.querySelector("#buzzer-control-button");
  const rulesButton = root.querySelector("#jeopardy-rules-button");
  let buzzerState = null;
  let buzzerConnected = false;
  let privateSolutionPreview = false;
  rulesButton.addEventListener("click", () => showRules().catch((error) => window.alert(error.message)));
  root.querySelector("#jeopardy-title").textContent = state.config.title;
  await publishJeopardy();

  function activeQuestionId() {
    return state.activeQuestion ? `${state.activeQuestion.categoryIndex}:${state.activeQuestion.rowIndex}` : null;
  }

  function currentRound() {
    return buzzerState?.round.questionId === activeQuestionId() ? buzzerState.round : null;
  }

  function renderBuzzer() {
    buzzOrder.replaceChildren();
    const round = currentRound();
    const buzzes = round?.buzzes || [];
    const activeBuzz = buzzes[0] || null;
    buzzerPanel.dataset.state = !buzzerConnected
      ? "disconnected"
      : (!round?.open ? "closed" : (activeBuzz ? "buzzed" : "open"));

    async function removeBuzz(buzz, button) {
      button.disabled = true;
      try {
        buzzerState = await controlBuzzer("remove", {
          questionId: activeQuestionId(),
          teamIndex: buzz.teamIndex
        });
        renderBuzzer();
      } catch (error) {
        buzzerPanel.dataset.state = "error";
        buzzerStatus.textContent = `Team konnte nicht entfernt werden: ${error.message}`;
        button.disabled = false;
      }
    }

    buzzerActive.hidden = !activeBuzz;
    buzzerEmpty.hidden = Boolean(activeBuzz);
    if (activeBuzz) {
      buzzerActiveTeam.textContent = activeBuzz.teamName;
      buzzerActive.setAttribute("aria-label", `${activeBuzz.teamName} antwortet jetzt`);
      buzzerActive.setAttribute("aria-current", "true");
      buzzerActiveRemove.textContent = "×";
      buzzerActiveRemove.setAttribute("aria-label", `${activeBuzz.teamName} aus der Buzzer-Reihenfolge entfernen`);
      buzzerActiveRemove.onclick = () => removeBuzz(activeBuzz, buzzerActiveRemove);
    } else {
      buzzerActive.removeAttribute("aria-label");
      buzzerActive.removeAttribute("aria-current");
      buzzerActiveRemove.onclick = null;
      buzzerEmptyDetail.textContent = round?.open
        ? "Der Buzzer ist offen und wartet auf ein Team."
        : "Der Buzzer ist noch geschlossen.";
    }

    const queuedBuzzes = buzzes.slice(1);
    buzzerQueueCount.textContent = `${queuedBuzzes.length} ${queuedBuzzes.length === 1 ? "Team" : "Teams"}`;
    queuedBuzzes.forEach((buzz, index) => {
      const item = document.createElement("li");
      const position = document.createElement("span");
      position.className = "buzz-position";
      position.textContent = String(index + 2);
      const name = document.createElement("span");
      name.className = "buzz-team-name";
      name.textContent = buzz.teamName;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "buzz-remove-button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `${buzz.teamName} aus der Buzzer-Reihenfolge entfernen`);
      remove.title = `${buzz.teamName} entfernen`;
      remove.addEventListener("click", () => removeBuzz(buzz, remove));
      item.append(position, name, remove);
      buzzOrder.append(item);
    });
    if (!round?.open) {
      buzzerStatus.textContent = "Gebt die Buzzer frei, sobald die Spieler bereit sind.";
      buzzerControl.textContent = "Buzzer freigeben";
    } else if (!buzzes.length) {
      buzzerStatus.textContent = "Die Buzzer sind offen. Warten auf ein Team…";
      buzzerControl.textContent = "Buzzer zurücksetzen";
    } else {
      buzzerStatus.textContent = `${activeBuzz.teamName} antwortet.`;
      buzzerControl.textContent = "Buzzer zurücksetzen";
    }
  }

  function setBuzzerConnection(connected) {
    buzzerConnected = connected;
    buzzerConnection.textContent = connected ? "Live verbunden" : "Verbindung wird wiederhergestellt…";
    buzzerConnection.classList.toggle("connected", connected);
    renderBuzzer();
  }

  const disconnectBuzzer = connectToBuzzer((nextState) => {
    buzzerState = nextState;
    renderBuzzer();
  }, setBuzzerConnection);

  buzzerControl.addEventListener("click", async () => {
    const questionId = activeQuestionId();
    if (!questionId) return;
    buzzerControl.disabled = true;
    try {
      const action = currentRound()?.open ? "reset" : "open";
      buzzerState = await controlBuzzer(action, { questionId });
      renderBuzzer();
    } catch (error) {
      buzzerPanel.dataset.state = "error";
      buzzerStatus.textContent = `Buzzer-Fehler: ${error.message}`;
    } finally {
      buzzerControl.disabled = false;
    }
  });

  async function handleScoreChange(event) {
    if (event.detail.source === "manual") return;
    publishJeopardy().catch(() => undefined);
    const round = currentRound();
    if (!round?.open || round.activeTeamIndex !== event.detail.teamIndex) return;
    const buzz = round.buzzes.find(({ teamIndex }) => teamIndex === event.detail.teamIndex);
    const { categoryIndex, rowIndex } = state.activeQuestion;
    recordAnalyticsEvent({
      id: `jeopardy:${round.id}:${event.detail.teamIndex}:${state.analyticsEvents.length}`,
      type: "jeopardy-answer",
      questionId: activeQuestionId(),
      category: state.config.games.jeopardy.categories[categoryIndex].name,
      value: state.config.games.jeopardy.values[rowIndex],
      teamIndex: event.detail.teamIndex,
      points: event.detail.amount,
      correct: event.detail.amount > 0,
      buzzPosition: buzz?.position ?? 1,
      responseMs: buzz?.responseMs ?? null
    });
    saveState().catch(() => undefined);
    try {
      buzzerState = await controlBuzzer("remove", {
        questionId: activeQuestionId(),
        teamIndex: event.detail.teamIndex
      });
      renderBuzzer();
    } catch (error) {
      buzzerStatus.textContent = `Die Buzzer-Reihenfolge konnte nicht fortgesetzt werden: ${error.message}`;
    }
  }
  window.addEventListener("quiz-score-changed", handleScoreChange);

  function setTileUsed(tile, used) {
    tile.classList.toggle("used", used);
    tile.setAttribute("aria-disabled", String(used));
    if (used) {
      tile.title = "Mit Rechtsklick kann diese Frage wiederhergestellt werden";
      tile.setAttribute("aria-label", `${tile.dataset.availableLabel}, verwendet. Mit Rechtsklick wiederherstellen.`);
    } else {
      tile.removeAttribute("title");
      tile.setAttribute("aria-label", tile.dataset.availableLabel);
    }
  }

  function renderBoard() {
    const { categories, values } = state.config.games.jeopardy;
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
      tile.textContent = formatInteger(value);
      tile.dataset.row = rowIndex;
      tile.dataset.category = categoryIndex;
      tile.dataset.availableLabel = `${category.name} für ${formatInteger(value)} Punkte`;
      setTileUsed(tile, state.usedTiles.has(`${categoryIndex}:${rowIndex}`));
      const tileId = `${categoryIndex}:${rowIndex}`;
      const publishTileHighlight = (highlighted) => {
        if (state.activeQuestion || tile.classList.contains("used")) return;
        publishJeopardy(highlighted ? tileId : null).catch(() => undefined);
      };
      tile.addEventListener("pointerenter", () => publishTileHighlight(true));
      tile.addEventListener("pointerleave", () => publishTileHighlight(false));
      tile.addEventListener("focus", () => publishTileHighlight(true));
      tile.addEventListener("blur", () => publishTileHighlight(false));
      tile.addEventListener("click", () => {
        if (!tile.classList.contains("used")) openQuestion(tile, categoryIndex, rowIndex);
      });
      tile.addEventListener("contextmenu", (event) => {
        if (!tile.classList.contains("used")) return;
        event.preventDefault();
        state.usedTiles.delete(`${categoryIndex}:${rowIndex}`);
        setTileUsed(tile, false);
        saveState().catch(() => undefined);
        publishJeopardy().catch(() => undefined);
      });
      board.append(tile);
    }));
  }

  function fitBoard() {
    const width = board.clientWidth;
    const height = board.clientHeight;
    if (!width || !height) return;
    const columnWidth = width / state.config.games.jeopardy.categories.length;
    const rowHeight = height / (state.config.games.jeopardy.values.length + 1.1);
    board.style.setProperty("--category-font-size", `${Math.max(6, Math.min(21, columnWidth * 0.15, rowHeight * 0.32))}px`);
    board.style.setProperty("--tile-font-size", `${Math.max(8, Math.min(35, columnWidth * 0.27, rowHeight * 0.48))}px`);
    board.style.setProperty("--board-gap", `${Math.max(1, Math.min(5, columnWidth * 0.02, rowHeight * 0.04))}px`);
    board.style.setProperty("--cell-padding", `${Math.max(1, Math.min(12, columnWidth * 0.05, rowHeight * 0.1))}px`);
  }

  function fitQuestionText() {
    if (!questionView.hidden) scheduleTextFit(root.querySelector("#card-content"));
  }

  function renderMedia(container, text, image) {
    container.replaceChildren();
    if (typeof text === "string" && text.trim()) {
      const element = document.createElement("div");
      element.textContent = text;
      element.classList.add("auto-fit-text");
      element.classList.toggle("long-text", text.length > 280);
      container.append(element);
    }
    if (image) {
      const element = document.createElement("img");
      element.alt = image.alt;
      element.addEventListener("load", fitQuestionText, { once: true });
      element.addEventListener("error", () => {
        const error = document.createElement("div");
        error.className = "image-error";
        error.textContent = `Bild konnte nicht geladen werden: ${image.src}`;
        element.replaceWith(error);
        fitQuestionText();
      }, { once: true });
      element.src = image.src;
      container.append(element);
    }
  }

  function audioTrackControls(track, target) {
    const row = document.createElement("div");
    row.className = "audio-track-controls";
    const label = document.createElement("strong");
    label.textContent = track.label;
    row.append(label);
    [["play", "▶ Abspielen"], ["pause", "⏸ Pause"], ["restart", "↺ Neustart"]].forEach(([action, text]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.addEventListener("click", async () => {
        row.querySelectorAll("button").forEach((item) => { item.disabled = true; });
        audioStatus.textContent = "Befehl wird an den Beamer gesendet…";
        try {
          await commandJeopardyAudio(action, target);
          audioStatus.textContent = `${track.label}: ${text.replace(/^[^ ]+ /, "")}`;
        } catch (error) {
          audioStatus.textContent = `Audiobefehl fehlgeschlagen: ${error.message}`;
        } finally {
          row.querySelectorAll("button").forEach((item) => { item.disabled = false; });
        }
      });
      row.append(button);
    });
    return row;
  }

  function renderAudioControls(item, answerRevealed) {
    audioTracks.replaceChildren();
    if (!answerRevealed && item.questionAudio) audioTracks.append(audioTrackControls(item.questionAudio, "question"));
    if (answerRevealed && item.answerAudio) audioTracks.append(audioTrackControls(item.answerAudio, "answer"));
    if (audioTracks.childElementCount) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "audio-stop-button";
      stop.textContent = "■ Stoppen";
      stop.addEventListener("click", async () => {
        stop.disabled = true;
        try {
          await commandJeopardyAudio("stop");
          audioStatus.textContent = "Wiedergabe gestoppt";
        } catch (error) {
          audioStatus.textContent = `Audiobefehl fehlgeschlagen: ${error.message}`;
        } finally {
          stop.disabled = false;
        }
      });
      audioTracks.append(stop);
    }
    audioControls.hidden = !audioTracks.childElementCount;
  }

  function displayQuestion() {
    const { categoryIndex, rowIndex, answerRevealed } = state.activeQuestion;
    const category = state.config.games.jeopardy.categories[categoryIndex];
    const item = category.questions[rowIndex];
    questionValue.textContent = `±${formatInteger(state.config.games.jeopardy.values[rowIndex])} Punkte`;
    renderMedia(questionContent, item.question, item.questionImage);
    renderMedia(answerContent, item.answer, item.answerImage);
    renderAudioControls(item, answerRevealed);
    const showingPrivateSolution = privateSolutionPreview && !answerRevealed;
    questionContent.hidden = answerRevealed || showingPrivateSolution;
    answerContent.hidden = !answerRevealed && !showingPrivateSolution;
    answerContent.classList.toggle("answer-only", answerRevealed || showingPrivateSolution);
    answerContent.classList.toggle("private-answer-preview", showingPrivateSolution);
    privateSolutionLabel.hidden = !showingPrivateSolution;
    privateSolutionButton.hidden = answerRevealed;
    privateSolutionButton.textContent = showingPrivateSolution ? "Frage ansehen" : "Lösung ansehen";
    privateSolutionButton.setAttribute("aria-pressed", String(showingPrivateSolution));
    revealButton.hidden = answerRevealed && !category.reviewQuestionAfterAnswer;
    revealButton.textContent = answerRevealed ? "Frage nochmals anzeigen" : "Antwort anzeigen";
    boardView.hidden = true;
    questionView.hidden = false;
    rulesButton.hidden = true;
    fitQuestionText();
  }

  function openQuestion(tile, categoryIndex, rowIndex) {
    state.activeValue = state.config.games.jeopardy.values[rowIndex];
    state.activeQuestion = { categoryIndex, rowIndex, answerRevealed: false };
    privateSolutionPreview = false;
    state.usedTiles.add(`${categoryIndex}:${rowIndex}`);
    setTileUsed(tile, true);
    updateScoreControls();
    displayQuestion();
    saveState().catch(() => undefined);
    commandJeopardyAudio("stop").catch(() => undefined);
  }

  revealButton.addEventListener("click", () => {
    const category = state.config.games.jeopardy.categories[state.activeQuestion.categoryIndex];
    privateSolutionPreview = false;
    state.activeQuestion.answerRevealed = state.activeQuestion.answerRevealed
      ? !category.reviewQuestionAfterAnswer
      : true;
    displayQuestion();
    saveState().catch(() => undefined);
    commandJeopardyAudio("stop").catch(() => undefined);
  });

  privateSolutionButton.addEventListener("click", () => {
    privateSolutionPreview = !privateSolutionPreview;
    displayQuestion();
  });

  root.querySelector("#continue-button").addEventListener("click", () => {
    if (currentRound()?.open) controlBuzzer("close").catch(() => undefined);
    commandJeopardyAudio("stop").catch(() => undefined);
    state.activeQuestion = null;
    privateSolutionPreview = false;
    state.activeValue = 0;
    updateScoreControls();
    questionView.hidden = true;
    boardView.hidden = false;
    rulesButton.hidden = false;
    requestAnimationFrame(fitBoard);
    saveState().catch(() => undefined);
    publishJeopardy().catch(() => undefined);
  });

  renderBoard();
  const observer = new ResizeObserver(fitBoard);
  observer.observe(board);
  const questionObserver = new ResizeObserver(fitQuestionText);
  questionObserver.observe(root.querySelector("#card-content"));
  if (state.activeQuestion) {
    state.activeValue = state.config.games.jeopardy.values[state.activeQuestion.rowIndex];
    updateScoreControls();
    displayQuestion();
  } else {
    state.activeValue = 0;
    updateScoreControls();
    requestAnimationFrame(fitBoard);
  }
  return () => {
    if (state.activeQuestion) commandJeopardyAudio("stop").catch(() => undefined);
    if (currentRound()?.open) {
      hostFetch("/api/buzzer/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
        keepalive: true
      }).catch(() => undefined);
    }
    observer.disconnect();
    questionObserver.disconnect();
    disconnectBuzzer();
    window.removeEventListener("quiz-score-changed", handleScoreChange);
  };
}
