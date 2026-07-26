const waitingStep = document.querySelector("#waiting-step");
const waitingTitle = document.querySelector("#waiting-title");
const waitingStatus = document.querySelector("#waiting-status");
const waitingTeamRow = document.querySelector("#waiting-team-row");
const waitingTeam = document.querySelector("#waiting-team");
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
const listingStep = document.querySelector("#listing-step");
const listingTeam = document.querySelector("#listing-team");
const listingTitle = document.querySelector("#listing-title");
const listingPrompt = document.querySelector("#listing-prompt");
const listingCountdown = document.querySelector("#listing-countdown");
const listingForm = document.querySelector("#listing-entry-form");
const listingEntry = document.querySelector("#listing-entry");
const listingLimit = document.querySelector("#listing-limit");
const listingItems = document.querySelector("#listing-items");
const listingSubmit = document.querySelector("#listing-submit");
const listingStatus = document.querySelector("#listing-phone-status");

let currentState = null;
let orderingState = null;
let listingState = null;
let presentationState = null;
let selectedTeamIndex = null;
let submitting = false;
let orderingEvents;
let listingEvents;
let orderingTimer;
let listingTimer;
let listingPendingSaves = 0;
let listingSaveChain = Promise.resolve();
let listingLocalRoundId = null;
let listingLocalItems = [];
let listingSubmissionQueued = false;
let listingSaveError = "";
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
  listingStep.hidden = true;
  connectOrderingEvents();
  connectListingEvents();
}

function showNoGameWaiting() {
  const hadSelection = selectedTeamIndex !== null;
  cancelDrag(false);
  selectedTeamIndex = null;
  localStorage.removeItem("quiz-buzzer-team");
  waitingTeamRow.hidden = true;
  waitingTitle.textContent = "Warten auf ein Spiel";
  waitingStatus.textContent = "Die Spielleitung hat noch kein Spiel gestartet. Lasst diese Seite geöffnet.";
  waitingStep.hidden = false;
  teamStep.hidden = true;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
  if (hadSelection) connectOrderingEvents();
  if (hadSelection) connectListingEvents();
}

function showActivityWaiting() {
  waitingTeam.textContent = currentState.teams[selectedTeamIndex];
  waitingTeamRow.hidden = false;
  waitingTitle.textContent = "Warten auf das nächste Spiel";
  waitingStatus.textContent = "Euer Team ist bereit. Wartet auf das nächste Spiel.";
  waitingStep.hidden = false;
  teamStep.hidden = true;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
}

function selectTeam(index) {
  selectedTeamIndex = index;
  localStorage.setItem("quiz-buzzer-team", JSON.stringify({ index, revision: currentState.teamsRevision }));
  waitingStep.hidden = true;
  teamStep.hidden = true;
  buzzStep.hidden = false;
  connectOrderingEvents();
  connectListingEvents();
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
    showNoGameWaiting();
    return;
  }
  waitingStep.hidden = true;
  const saved = savedSelection();
  let restoredSelection = false;
  if (selectedTeamIndex === null && saved?.revision === currentState.teamsRevision
      && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < currentState.teams.length) {
    selectedTeamIndex = saved.index;
    restoredSelection = true;
  }
  if (selectedTeamIndex !== null && (saved?.revision !== currentState.teamsRevision
      || selectedTeamIndex >= currentState.teams.length)) {
    showTeamSelection();
  }
  if (restoredSelection) {
    connectOrderingEvents();
    connectListingEvents();
  }
  renderTeams();
  if (selectedTeamIndex === null) {
    teamStep.hidden = false;
    buzzStep.hidden = true;
    orderingStep.hidden = true;
    listingStep.hidden = true;
    return;
  }

  teamStep.hidden = true;
  if (presentationState?.screen === "ordering" && orderingState?.round) {
    buzzStep.hidden = true;
    listingStep.hidden = true;
    orderingStep.hidden = false;
    renderOrdering();
    return;
  }
  if (presentationState?.screen === "listing" && listingState?.round) {
    buzzStep.hidden = true;
    orderingStep.hidden = true;
    listingStep.hidden = false;
    renderListing();
    return;
  }
  if (!["jeopardy-board", "jeopardy-question"].includes(presentationState?.screen)) {
    showActivityWaiting();
    return;
  }
  waitingStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
  buzzStep.hidden = false;
  selectedTeamLabel.textContent = currentState.teams[selectedTeamIndex];
  const round = currentState.round;
  const ownBuzzIndex = round.buzzes.findIndex((buzz) => buzz.teamIndex === selectedTeamIndex);
  buzzButton.classList.toggle("registered", ownBuzzIndex !== -1);
  if (!round.open) {
    buzzButton.disabled = true;
    buzzButton.textContent = "WARTEN";
    buzzStatus.textContent = "Die Spielleitung hat die Buzzer noch nicht freigegeben.";
  } else if (ownBuzzIndex !== -1) {
    buzzButton.disabled = true;
    buzzButton.textContent = ownBuzzIndex === 0 ? "ERSTER!" : `#${ownBuzzIndex + 1}`;
    buzzStatus.textContent = `Euer Team ist Nummer ${ownBuzzIndex + 1} in der Buzzer-Reihenfolge.`;
  } else {
    buzzButton.disabled = submitting;
    buzzButton.textContent = submitting ? "WIRD GESENDET" : "BUZZ";
    buzzStatus.textContent = "Die Buzzer sind offen!";
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
    orderingStatus.textContent = "Verschiebt das Element und lasst es los, um zu speichern.";
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
  orderingStatus.textContent = "Wird gespeichert…";
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
    if (!response.ok) throw new Error(payload.error || "Die Reihenfolge wurde nicht akzeptiert.");
    orderingStatus.textContent = "Gespeichert";
  } catch (error) {
    orderingStatus.textContent = error.message || "Die Spielleitung konnte nicht erreicht werden.";
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
    orderingStatus.textContent = "Die Zeit ist abgelaufen. Eure Antwort ist gesperrt.";
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
    row.setAttribute("aria-label", `${text.get(id)}. Zum Umsortieren ziehen.`);
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
    orderingStatus.textContent = "Verbindung verloren. Verbindung wird wiederhergestellt…";
  });
}

function focusListingEntry() {
  const round = listingState?.round;
  if (!round || round.phase !== "active" || round.teamSubmitted || listingSubmissionQueued
      || listingLocalItems.length >= round.maxItems) return;
  requestAnimationFrame(() => {
    if (!listingEntry.hidden && !listingEntry.disabled && listingEntry.isConnected) {
      listingEntry.focus({ preventScroll: true });
    }
  });
}

function saveListingItems(items, submit = false) {
  const round = listingState?.round;
  if (!round || selectedTeamIndex === null || round.phase !== "active"
      || round.teamSubmitted || listingSubmissionQueued) return listingSaveChain;
  const requestData = {
    roundId: round.id,
    teamsRevision: listingState.teamsRevision,
    teamIndex: selectedTeamIndex,
    items: [...items],
    submit
  };
  listingLocalItems = [...items];
  listingSaveError = "";
  if (submit) listingSubmissionQueued = true;
  listingPendingSaves += 1;
  renderListing();
  if (!submit) focusListingEntry();
  listingSaveChain = listingSaveChain.catch(() => undefined).then(async () => {
    const response = await fetch("/api/listing/submission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestData)
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.state) listingState = payload.state;
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  }).catch((error) => {
    listingSaveError = error.message || "Die Spielleitung konnte nicht erreicht werden.";
  }).finally(() => {
    listingPendingSaves -= 1;
    if (listingPendingSaves === 0 && listingState?.round?.id === listingLocalRoundId) {
      listingLocalItems = [...(listingState.round.teamItems || listingLocalItems)];
      listingSubmissionQueued = listingState.round.teamSubmitted;
    }
    render();
    if (!listingSubmissionQueued) focusListingEntry();
  });
  return listingSaveChain;
}

function renderListing() {
  const round = listingState.round;
  const active = round.phase === "active";
  if (listingLocalRoundId !== round.id) {
    listingLocalRoundId = round.id;
    listingLocalItems = [...(round.teamItems || [])];
    listingSubmissionQueued = round.teamSubmitted;
    listingPendingSaves = 0;
    listingSaveChain = Promise.resolve();
    listingSaveError = "";
  } else if (listingPendingSaves === 0 && !listingSubmissionQueued) {
    listingLocalItems = [...(round.teamItems || listingLocalItems)];
  }
  listingTeam.textContent = listingState.teams[selectedTeamIndex] || "";
  listingTitle.textContent = round.title;
  listingPrompt.textContent = round.prompt;
  listingCountdown.hidden = !active;
  listingForm.hidden = !active || round.teamSubmitted;
  listingSubmit.hidden = !active || round.teamSubmitted;
  listingItems.hidden = !active;
  listingLimit.hidden = !active;
  if (!active) {
    listingStatus.textContent = round.phase === "classifying"
      ? "Eure Liste wird geprüft."
      : "Eure Liste ist gesperrt. Wartet auf das Ergebnis.";
    return;
  }
  const items = listingLocalItems;
  listingCountdown.dataset.deadline = round.deadlineAt;
  listingCountdown.textContent = Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000));
  listingLimit.textContent = `${items.length} von ${round.maxItems} Einträgen`;
  listingEntry.disabled = items.length >= round.maxItems;
  listingSubmit.disabled = listingSubmissionQueued;
  listingItems.replaceChildren();
  items.forEach((text, index) => {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "listing-remove";
    remove.setAttribute("aria-label", `${text} löschen`);
    remove.textContent = "🗑";
    remove.disabled = round.teamSubmitted || listingSubmissionQueued;
    remove.addEventListener("click", () => {
      saveListingItems(items.filter((_, itemIndex) => itemIndex !== index));
      focusListingEntry();
    });
    row.append(label, remove);
    listingItems.append(row);
  });
  if (listingSaveError) {
    listingStatus.textContent = listingSaveError;
  } else if (round.teamSubmitted || listingSubmissionQueued) {
    listingStatus.textContent = "Eure Liste wurde abgegeben.";
  } else if (listingPendingSaves > 0) {
    listingStatus.textContent = "Wird gespeichert …";
  } else {
    listingStatus.textContent = "Ihr könnt bis zum Ablauf der Zeit weiterarbeiten oder frühzeitig abgeben.";
  }
  focusListingEntry();
}

function connectListingEvents() {
  listingEvents?.close();
  const query = selectedTeamIndex === null ? "" : `?teamIndex=${selectedTeamIndex}`;
  listingEvents = new EventSource(`/api/listing/events${query}`);
  listingEvents.addEventListener("state", (event) => {
    listingState = JSON.parse(event.data);
    render();
  });
  listingEvents.addEventListener("error", () => {
    listingStatus.textContent = "Verbindung verloren. Verbindung wird wiederhergestellt …";
  });
}

async function loadState() {
  const response = await fetch("/api/buzzer/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  currentState = await response.json();
  render();
}

document.querySelector("#change-team").addEventListener("click", showTeamSelection);
document.querySelector("#waiting-change-team").addEventListener("click", showTeamSelection);
document.querySelector("#ordering-change-team").addEventListener("click", showTeamSelection);
document.querySelector("#listing-change-team").addEventListener("click", showTeamSelection);
listingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = listingEntry.value.trim();
  const round = listingState?.round;
  if (!value || !round || round.teamSubmitted) return;
  const items = round.teamItems || [];
  const currentItems = listingLocalRoundId === round.id ? listingLocalItems : items;
  if (currentItems.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) {
    listingStatus.textContent = "Dieser Eintrag steht bereits in eurer Liste.";
    listingEntry.focus({ preventScroll: true });
    return;
  }
  if (currentItems.length >= round.maxItems) return;
  listingEntry.value = "";
  listingEntry.focus({ preventScroll: true });
  saveListingItems([...currentItems, value]);
});
listingSubmit.addEventListener("click", () => {
  if (!listingState?.round) return;
  saveListingItems(listingLocalItems, true);
});
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
    if (!response.ok) errorMessage = result.error || "Der Buzzer wurde nicht akzeptiert.";
    else if (navigator.vibrate) navigator.vibrate(100);
  } catch {
    errorMessage = "Die Quiz-Spielleitung konnte nicht erreicht werden. Prüft die WLAN-Verbindung.";
  } finally {
    submitting = false;
    render();
    if (errorMessage) buzzStatus.textContent = errorMessage;
  }
});

const events = new EventSource("/api/buzzer/events");
events.addEventListener("state", (event) => {
  currentState = JSON.parse(event.data);
  connectionStatus.textContent = "Verbunden";
  connectionStatus.classList.add("connected");
  render();
});
events.addEventListener("error", () => {
  connectionStatus.textContent = "Verbindung wird wiederhergestellt…";
  connectionStatus.classList.remove("connected");
});

const presentationEvents = new EventSource("/api/presentation/events");
presentationEvents.addEventListener("state", (event) => {
  presentationState = JSON.parse(event.data);
  render();
});

async function loadPresentationState() {
  const response = await fetch("/api/presentation/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  presentationState = await response.json();
  render();
}

Promise.all([loadState(), loadPresentationState()]).catch(() => {
  connectionStatus.textContent = "Offline";
  waitingStatus.textContent = "Die Quiz-Spielleitung konnte nicht erreicht werden. Prüft die WLAN-Verbindung.";
});

connectOrderingEvents();
connectListingEvents();
orderingTimer = setInterval(() => {
  if (!orderingState?.round || orderingState.round.phase !== "active") return;
  const seconds = Math.max(0, Math.ceil((orderingState.round.deadlineAt - Date.now()) / 1000));
  orderingCountdown.textContent = seconds;
  if (seconds === 0 && activeDrag) {
    cancelDrag();
    orderingList.classList.add("locked-pending");
    orderingStatus.textContent = "Die Zeit ist abgelaufen. Eure Antwort wird gesperrt…";
  }
}, 200);

listingTimer = setInterval(() => {
  if (!listingState?.round || listingState.round.phase !== "active") return;
  const seconds = Math.max(0, Math.ceil((listingState.round.deadlineAt - Date.now()) / 1000));
  listingCountdown.textContent = seconds;
  if (seconds === 0) listingStatus.textContent = "Die Zeit ist abgelaufen. Eure Liste wird automatisch abgegeben …";
}, 200);

window.addEventListener("pagehide", () => cancelDrag(false));
