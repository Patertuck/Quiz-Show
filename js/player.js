const waitingStep = document.querySelector("#waiting-step");
const waitingStatus = document.querySelector("#waiting-status");
const teamStep = document.querySelector("#team-step");
const buzzStep = document.querySelector("#buzz-step");
const choices = document.querySelector("#team-choices");
const selectedTeamLabel = document.querySelector("#selected-team");
const buzzButton = document.querySelector("#buzz-button");
const buzzStatus = document.querySelector("#buzz-status");
const connectionStatus = document.querySelector("#connection-status");
const orderingStep = document.querySelector("#ordering-step");
const orderingTeam = document.querySelector("#ordering-team");
const orderingTitle = document.querySelector("#ordering-title");
const orderingPrompt = document.querySelector("#ordering-prompt");
const orderingCountdown = document.querySelector("#ordering-countdown");
const orderingList = document.querySelector("#ordering-list");
const orderingStatus = document.querySelector("#ordering-phone-status");

let currentState = null;
let orderingState = null;
let selectedTeamIndex = null;
let submitting = false;
let orderingEvents;
let orderingTimer;
let activeDrag = null;
let deferredOrderingState = null;
const newDeviceId = () => crypto.randomUUID?.()
  || Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("");
const deviceId = localStorage.getItem("quiz-buzzer-device") || newDeviceId();
localStorage.setItem("quiz-buzzer-device", deviceId);

function savedSelection() {
  try { return JSON.parse(localStorage.getItem("quiz-buzzer-team")); }
  catch { return null; }
}

function showTeamSelection() {
  cancelDrag(false);
  selectedTeamIndex = null;
  localStorage.removeItem("quiz-buzzer-team");
  waitingStep.hidden = true;
  teamStep.hidden = false;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  connectOrderingEvents();
}

function showWaiting() {
  const hadSelection = selectedTeamIndex !== null;
  cancelDrag(false);
  selectedTeamIndex = null;
  localStorage.removeItem("quiz-buzzer-team");
  waitingStatus.textContent = "The host has not started a game yet. Keep this page open.";
  waitingStep.hidden = false;
  teamStep.hidden = true;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  if (hadSelection) connectOrderingEvents();
}

function selectTeam(index) {
  selectedTeamIndex = index;
  localStorage.setItem("quiz-buzzer-team", JSON.stringify({ index, revision: currentState.teamsRevision }));
  waitingStep.hidden = true;
  teamStep.hidden = true;
  buzzStep.hidden = false;
  connectOrderingEvents();
  render();
}

function renderTeams() {
  choices.replaceChildren();
  currentState.teams.forEach((team, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "team-choice";
    button.textContent = team;
    button.addEventListener("click", () => selectTeam(index));
    choices.append(button);
  });
}

function render() {
  if (!currentState) return;
  if (!currentState.teams.length) {
    showWaiting();
    return;
  }
  waitingStep.hidden = true;
  const saved = savedSelection();
  if (selectedTeamIndex === null && saved?.revision === currentState.teamsRevision
      && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < currentState.teams.length) {
    selectedTeamIndex = saved.index;
  }
  if (selectedTeamIndex !== null && (saved?.revision !== currentState.teamsRevision
      || selectedTeamIndex >= currentState.teams.length)) {
    showTeamSelection();
  }
  renderTeams();
  if (selectedTeamIndex === null) {
    teamStep.hidden = false;
    buzzStep.hidden = true;
    orderingStep.hidden = true;
    return;
  }

  teamStep.hidden = true;
  if (orderingState?.round) {
    buzzStep.hidden = true;
    orderingStep.hidden = false;
    renderOrdering();
    return;
  }
  orderingStep.hidden = true;
  buzzStep.hidden = false;
  selectedTeamLabel.textContent = currentState.teams[selectedTeamIndex];
  const round = currentState.round;
  const ownBuzzIndex = round.buzzes.findIndex((buzz) => buzz.teamIndex === selectedTeamIndex);
  buzzButton.classList.toggle("registered", ownBuzzIndex !== -1);
  if (!round.open) {
    buzzButton.disabled = true;
    buzzButton.textContent = "WAIT";
    buzzStatus.textContent = "The host has not opened the buzzers yet.";
  } else if (ownBuzzIndex !== -1) {
    buzzButton.disabled = true;
    buzzButton.textContent = ownBuzzIndex === 0 ? "FIRST!" : `#${ownBuzzIndex + 1}`;
    buzzStatus.textContent = `Your team is number ${ownBuzzIndex + 1} in the buzz order.`;
  } else {
    buzzButton.disabled = submitting;
    buzzButton.textContent = submitting ? "SENDING" : "BUZZ";
    buzzStatus.textContent = "Buzzers are open!";
  }
}

function moveOrder(order, from, to) {
  if (from === to || to < 0 || to >= order.length) return order;
  const result = [...order];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

function applyDeferredOrderingState() {
  if (!deferredOrderingState) return;
  orderingState = deferredOrderingState;
  deferredOrderingState = null;
}

function cleanUpDrag(drag) {
  window.removeEventListener("pointermove", drag.onMove);
  window.removeEventListener("pointerup", drag.onEnd);
  window.removeEventListener("pointercancel", drag.onCancel);
  if (drag.row.hasPointerCapture?.(drag.pointerId)) drag.row.releasePointerCapture(drag.pointerId);
  drag.row.classList.remove("drag-placeholder");
  drag.row.style.removeProperty("height");
  drag.ghost?.remove();
  document.body.classList.remove("ordering-is-dragging");
  if (activeDrag === drag) activeDrag = null;
}

function cancelDrag(renderAfter = true) {
  if (activeDrag) cleanUpDrag(activeDrag);
  applyDeferredOrderingState();
  if (renderAfter) render();
}

function startPointerDrag(event, row, startIndex, order) {
  if (activeDrag || submitting || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  const drag = {
    row, startIndex, order: [...order], pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY, offsetY: 0,
    started: false, ghost: null, onMove: null, onEnd: null, onCancel: null
  };
  activeDrag = drag;

  const begin = () => {
    const bounds = row.getBoundingClientRect();
    drag.started = true;
    drag.offsetY = Math.max(0, Math.min(bounds.height, drag.startY - bounds.top));
    drag.ghost = row.cloneNode(true);
    drag.ghost.classList.add("drag-ghost");
    drag.ghost.setAttribute("aria-hidden", "true");
    drag.ghost.style.left = `${bounds.left}px`;
    drag.ghost.style.top = `${bounds.top}px`;
    drag.ghost.style.width = `${bounds.width}px`;
    drag.ghost.style.height = `${bounds.height}px`;
    row.style.height = `${bounds.height}px`;
    row.classList.add("drag-placeholder");
    document.body.append(drag.ghost);
    document.body.classList.add("ordering-is-dragging");
    orderingStatus.textContent = "Move the item, then release to save.";
  };

  drag.onMove = (moveEvent) => {
    if (moveEvent.pointerId !== drag.pointerId) return;
    const distance = Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY);
    if (!drag.started && distance < 6) return;
    if (!drag.started) begin();
    moveEvent.preventDefault();
    drag.ghost.style.top = `${moveEvent.clientY - drag.offsetY}px`;

    const siblings = Array.from(orderingList.children).filter((item) => item !== row);
    const before = siblings.find((item) => {
      const bounds = item.getBoundingClientRect();
      return moveEvent.clientY < bounds.top + bounds.height / 2;
    });
    orderingList.insertBefore(row, before || null);

    const edge = 65;
    if (moveEvent.clientY < edge) window.scrollBy(0, -12);
    else if (moveEvent.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
  };

  drag.onEnd = (upEvent) => {
    if (upEvent.pointerId !== drag.pointerId) return;
    const finalIndex = Array.from(orderingList.children).indexOf(row);
    const wasStarted = drag.started;
    cleanUpDrag(drag);
    if (!wasStarted || finalIndex === startIndex) {
      applyDeferredOrderingState();
      render();
      return;
    }
    deferredOrderingState = null;
    orderingList.classList.add("saving");
    submitOrder(moveOrder(order, startIndex, finalIndex));
  };

  drag.onCancel = (cancelEvent) => {
    if (cancelEvent.pointerId !== drag.pointerId) return;
    cancelDrag();
  };
  window.addEventListener("pointermove", drag.onMove, { passive: false });
  window.addEventListener("pointerup", drag.onEnd);
  window.addEventListener("pointercancel", drag.onCancel);
  row.setPointerCapture(event.pointerId);
}

async function submitOrder(order) {
  const round = orderingState?.round;
  if (!round || selectedTeamIndex === null || round.phase !== "active") return;
  orderingStatus.textContent = "Saving…";
  try {
    const response = await fetch("/api/ordering/order", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roundId: round.id, teamsRevision: orderingState.teamsRevision,
        teamIndex: selectedTeamIndex, deviceId, order
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.state) orderingState = payload.state;
    if (!response.ok) throw new Error(payload.error || "The order was not accepted.");
    orderingStatus.textContent = "Saved";
  } catch (error) {
    orderingStatus.textContent = error.message || "Could not reach the host.";
  }
  render();
}

function renderOrdering() {
  const round = orderingState.round;
  orderingTeam.textContent = orderingState.teams[selectedTeamIndex] || "";
  orderingTitle.textContent = round.title;
  orderingPrompt.textContent = round.prompt;
  const active = round.phase === "active";
  orderingCountdown.hidden = !active;
  orderingList.hidden = !active;
  if (!active) {
    if (activeDrag) cancelDrag(false);
    orderingStatus.textContent = "Time is up. Your answer is locked.";
    return;
  }
  if (activeDrag) return;
  orderingList.classList.remove("saving", "locked-pending");
  orderingCountdown.dataset.deadline = round.deadlineAt;
  orderingCountdown.textContent = Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000));
  const order = round.teamOrder || round.shuffledItems.map((item) => item.id);
  const text = new Map(round.shuffledItems.map((item) => [item.id, item.text]));
  orderingList.replaceChildren();
  order.forEach((id, index) => {
    const row = document.createElement("li");
    row.className = "ordering-phone-item";
    row.dataset.index = index;
    row.setAttribute("aria-label", `${text.get(id)}. Drag to reorder.`);
    const label = document.createElement("span"); label.className = "ordering-item-text"; label.textContent = text.get(id);
    row.append(label); orderingList.append(row);
    row.addEventListener("pointerdown", (event) => startPointerDrag(event, row, index, order));
  });
}

function connectOrderingEvents() {
  orderingEvents?.close();
  const query = selectedTeamIndex === null ? "" : `?teamIndex=${selectedTeamIndex}`;
  orderingEvents = new EventSource(`/api/ordering/events${query}`);
  orderingEvents.addEventListener("state", (event) => {
    const nextState = JSON.parse(event.data);
    if (activeDrag) {
      deferredOrderingState = nextState;
      if (nextState.round?.id !== orderingState?.round?.id || nextState.round?.phase !== "active") cancelDrag();
      return;
    }
    orderingState = nextState;
    render();
  });
  orderingEvents.addEventListener("error", () => {
    if (activeDrag) cancelDrag();
    orderingStatus.textContent = "Connection lost. Reconnecting…";
  });
}

async function loadState() {
  const response = await fetch("/api/buzzer/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  currentState = await response.json();
  render();
}

document.querySelector("#change-team").addEventListener("click", showTeamSelection);
document.querySelector("#ordering-change-team").addEventListener("click", showTeamSelection);
buzzButton.addEventListener("click", async () => {
  if (!currentState?.round.open || selectedTeamIndex === null || submitting) return;
  submitting = true;
  let errorMessage = "";
  render();
  try {
    const response = await fetch("/api/buzzer/buzz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roundId: currentState.round.id,
        teamsRevision: currentState.teamsRevision,
        teamIndex: selectedTeamIndex,
        deviceId
      })
    });
    const result = await response.json().catch(() => ({}));
    if (result.state) currentState = result.state;
    if (!response.ok) errorMessage = result.error || "The buzz was not accepted.";
    else if (navigator.vibrate) navigator.vibrate(100);
  } catch {
    errorMessage = "Could not reach the quiz host. Check the Wi-Fi connection.";
  } finally {
    submitting = false;
    render();
    if (errorMessage) buzzStatus.textContent = errorMessage;
  }
});

const events = new EventSource("/api/buzzer/events");
events.addEventListener("state", (event) => {
  currentState = JSON.parse(event.data);
  connectionStatus.textContent = "Connected";
  connectionStatus.classList.add("connected");
  render();
});
events.addEventListener("error", () => {
  connectionStatus.textContent = "Reconnecting…";
  connectionStatus.classList.remove("connected");
});

loadState().catch(() => {
  connectionStatus.textContent = "Offline";
  waitingStatus.textContent = "Could not reach the quiz host. Check the Wi-Fi connection.";
});

connectOrderingEvents();
orderingTimer = setInterval(() => {
  if (!orderingState?.round || orderingState.round.phase !== "active") return;
  const seconds = Math.max(0, Math.ceil((orderingState.round.deadlineAt - Date.now()) / 1000));
  orderingCountdown.textContent = seconds;
  if (seconds === 0 && activeDrag) {
    cancelDrag();
    orderingList.classList.add("locked-pending");
    orderingStatus.textContent = "Time is up. Locking your answer…";
  }
}, 200);

window.addEventListener("pagehide", () => cancelDrag(false));
