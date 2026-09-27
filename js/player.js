import { playerCommands } from "./player/commands.js";
import { loadPlayerIdentity, saveTeamSelection, clearTeamSelection } from "./player/identity.js";
import { appendUniqueItem } from "./player/listing.js";
import { connectPlayerSession } from "./player/live-session.js";
import { moveOrder } from "./player/ordering.js";
import { ownSyncParticipant as findOwnSyncParticipant } from "./player/sync.js";
import { applyTeamColor } from "./team-colors.js";

const waitingStep = document.querySelector("#waiting-step");
const waitingLogo = document.querySelector(".player-waiting-logo");
const waitingTitle = document.querySelector("#waiting-title");
const waitingStatus = document.querySelector("#waiting-status");
const waitingTeamRow = document.querySelector("#waiting-team-row");
const waitingTeam = document.querySelector("#waiting-team");
const teamStep = document.querySelector("#team-step");
const teamLobbyStep = document.querySelector("#team-lobby-step");
const teamLobbyChoices = document.querySelector("#team-lobby-choices");
const teamLobbyCreateForm = document.querySelector("#team-lobby-create-form");
const teamLobbyName = document.querySelector("#team-lobby-name");
const teamLobbyStatus = document.querySelector("#team-lobby-status");
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
const listingItemCount = document.querySelector("#listing-item-count");
const listingForm = document.querySelector("#listing-entry-form");
const listingEntry = document.querySelector("#listing-entry");
const listingAdd = listingForm.querySelector("button[type='submit']");
const listingItems = document.querySelector("#listing-items");
const listingStatus = document.querySelector("#listing-phone-status");
const syncRegisterStep = document.querySelector("#sync-register-step");
const syncRegisterTeam = document.querySelector("#sync-register-team");
const syncTeamSelection = document.querySelector("#sync-team-selection");
const syncNameSelection = document.querySelector("#sync-name-selection");
const syncRegistrationBack = document.querySelector("#sync-registration-back");
const syncTeamChoices = document.querySelector("#sync-team-choices");
const syncTeamCreateForm = document.querySelector("#sync-team-create-form");
const syncTeamName = document.querySelector("#sync-team-name");
const syncRegisterForm = document.querySelector("#sync-register-form");
const syncName = document.querySelector("#sync-name");
const syncRegisterStatus = document.querySelector("#sync-register-status");
const syncStep = document.querySelector("#sync-step");
const syncTeam = document.querySelector("#sync-team");
const syncEditRegistration = document.querySelector("#sync-edit-registration");
const syncShowTeamRename = document.querySelector("#sync-show-team-rename");
const syncRenameSelf = document.querySelector("#sync-rename-self");
const syncCancelTeamRename = document.querySelector("#sync-cancel-team-rename");
const syncMemberActions = document.querySelector("#sync-member-actions");
const syncTeamRenameForm = document.querySelector("#sync-team-rename-form");
const syncTeamRename = document.querySelector("#sync-team-rename");
const syncPrompt = document.querySelector("#sync-prompt");
const syncCountdown = document.querySelector("#sync-countdown");
const syncChoices = document.querySelector("#sync-person-choices");
const syncStatus = document.querySelector("#sync-phone-status");

let currentState = null;
let orderingState = null;
let listingState = null;
let presentationState = null;
let syncState = null;
let teamLobbyState = null;
let selectedTeamIndex = null;
let submitting = false;
let liveConnection;
let editingSyncRegistration = false;
let selectedSyncTeamId = null;
let syncRegistrationStage = "teams";
let orderingTimer;
let listingPendingSaves = 0;
let listingSaveChain = Promise.resolve();
let listingLocalRoundId = null;
let listingLocalItems = [];
let listingSaveError = "";
let activeDrag = null;
let deferredOrderingState = null;
let wasConnected = false;
let playerConnected = false;
const playerIdentity = loadPlayerIdentity();
const deviceId = playerIdentity.deviceId;

function haptic(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* Haptics are optional. */ }
}

function confirmStatus(element, message, vibrate = false) {
  element.textContent = message;
  element.classList.remove("feedback-confirmed");
  void element.offsetWidth;
  element.classList.add("feedback-confirmed");
  if (vibrate) haptic([45, 30, 70]);
}

function showTeamSelection() {
  cancelDrag(false);
  selectedTeamIndex = null;
  clearTeamSelection();
  playerIdentity.teamSelection = null;
  waitingStep.hidden = true;
  teamStep.hidden = false;
  teamLobbyStep.hidden = true;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
  syncRegisterStep.hidden = true;
  syncStep.hidden = true;
  connectOrderingEvents();
  connectListingEvents();
  connectSyncEvents();
}

function showNoGameWaiting() {
  const hadSelection = selectedTeamIndex !== null;
  cancelDrag(false);
  selectedTeamIndex = null;
  clearTeamSelection();
  playerIdentity.teamSelection = null;
  waitingTeamRow.hidden = true;
  waitingTitle.textContent = "Warten auf ein Spiel";
  waitingStatus.hidden = false;
  waitingStatus.textContent = "Die Spielleitung hat noch kein Spiel gestartet. Lasst diese Seite geöffnet.";
  waitingStep.hidden = false;
  teamStep.hidden = true;
  teamLobbyStep.hidden = true;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
  syncRegisterStep.hidden = true;
  syncStep.hidden = true;
  if (hadSelection) connectOrderingEvents();
  if (hadSelection) connectListingEvents();
}

function showActivityWaiting() {
  waitingTeam.textContent = currentState.teams[selectedTeamIndex];
  waitingTeamRow.hidden = false;
  waitingTitle.textContent = "Warten auf das nächste Spiel";
  waitingStatus.hidden = true;
  waitingStatus.textContent = "";
  waitingStep.hidden = false;
  teamStep.hidden = true;
  teamLobbyStep.hidden = true;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
  syncRegisterStep.hidden = true;
  syncStep.hidden = true;
}

function selectTeam(index) {
  selectedTeamIndex = index;
  playerIdentity.teamSelection = { index, revision: currentState.teamsRevision };
  saveTeamSelection(playerIdentity.teamSelection);
  waitingStep.hidden = true;
  teamStep.hidden = true;
  buzzStep.hidden = false;
  connectOrderingEvents();
  connectListingEvents();
  connectSyncEvents();
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

async function teamLobbyAction(action, extra = {}) {
  if (!playerConnected) return false;
  teamLobbyStatus.textContent = "";
  try {
    const payload = await playerCommands.teamLobby({ action, deviceId, ...extra });
    if (payload.state) teamLobbyState = payload.state;
    else if (payload.phase && Array.isArray(payload.teams)) teamLobbyState = payload;
    render();
    return true;
  } catch (error) {
    teamLobbyStatus.textContent = error.message;
    haptic([80, 40, 80]);
    return false;
  }
}

function renderTeamLobby() {
  waitingStep.hidden = true;
  teamStep.hidden = true;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
  syncRegisterStep.hidden = true;
  syncStep.hidden = true;
  teamLobbyStep.hidden = false;
  teamLobbyChoices.replaceChildren();
  teamLobbyState.teams.forEach((team) => {
    const card = document.createElement("section");
    card.className = `team-lobby-phone-team${teamLobbyState.selectedTeamId === team.id ? " selected" : ""}`;
    applyTeamColor(card, team.color);
    const name = document.createElement("strong");
    name.textContent = team.name;
    card.append(name);
    const meta = document.createElement("span");
    meta.textContent = `${team.memberCount} ${team.memberCount === 1 ? "Handy" : "Handys"}`;
    const join = document.createElement("button");
    join.type = "button";
    join.textContent = teamLobbyState.selectedTeamId === team.id ? "Beigetreten" : "Beitreten";
    join.disabled = teamLobbyState.selectedTeamId === team.id;
    join.addEventListener("click", () => teamLobbyAction("join", { teamId: team.id }));
    card.append(meta, join);
    if (teamLobbyState.selectedTeamId === team.id) {
      const colors = document.createElement("div");
      colors.className = "team-lobby-phone-colors";
      const currentColor = teamLobbyState.colorPalette.find((color) => color.id === team.color);
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "team-lobby-color-trigger";
      trigger.style.setProperty("--choice-color", currentColor.value);
      trigger.title = `Teamfarbe: ${currentColor.label}`;
      trigger.setAttribute("aria-label", `Teamfarbe ändern. Aktuell ${currentColor.label}`);
      trigger.setAttribute("aria-expanded", "false");
      const options = document.createElement("div");
      options.className = "team-lobby-color-options";
      options.hidden = true;
      trigger.addEventListener("click", () => {
        const opening = options.hidden;
        options.hidden = !opening;
        trigger.setAttribute("aria-expanded", String(opening));
      });
      teamLobbyState.colorPalette.forEach((color) => {
        const button = document.createElement("button");
        button.type = "button";
        button.style.setProperty("--choice-color", color.value);
        button.className = team.color === color.id ? "selected" : "";
        const owner = teamLobbyState.teams.find((candidate) => candidate.id !== team.id && candidate.color === color.id);
        button.disabled = Boolean(owner);
        button.title = owner ? `${color.label}: ${owner.name}` : color.label;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(team.color === color.id));
        button.addEventListener("click", () => teamLobbyAction("set-color", { teamId: team.id, color: color.id }));
        options.append(button);
      });
      colors.append(trigger, options);
      card.append(colors);
    }
    teamLobbyChoices.append(card);
  });
  teamLobbyCreateForm.hidden = Boolean(teamLobbyState.ownedTeamId)
    || teamLobbyState.teams.length >= teamLobbyState.maxTeams;
}

function render() {
  reconcileLiveStreams();
  if (presentationState?.logos?.main && waitingLogo.src !== new URL(presentationState.logos.main, location.href).href) {
    waitingLogo.src = presentationState.logos.main;
  }
  if (!currentState) return;
  if (teamLobbyState?.phase === "open") {
    renderTeamLobby();
    return;
  }
  if (teamLobbyState?.phase === "locked" && selectedTeamIndex === null && teamLobbyState.selectedTeamId) {
    const selectedIndex = teamLobbyState.teams.findIndex((team) => team.id === teamLobbyState.selectedTeamId);
    const rosterReady = currentState.teams.length === teamLobbyState.teams.length
      && currentState.teams.every((name, index) => name === teamLobbyState.teams[index].name);
    if (rosterReady && selectedIndex >= 0) selectTeam(selectedIndex);
  }
  if (!currentState.teams.length) {
    showNoGameWaiting();
    return;
  }
  waitingStep.hidden = true;
  teamLobbyStep.hidden = true;
  const saved = playerIdentity.teamSelection;
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
    syncRegisterStep.hidden = true;
    syncStep.hidden = true;
    return;
  }

  teamStep.hidden = true;
  if (presentationState?.screen === "ordering") {
    buzzStep.hidden = true;
    listingStep.hidden = true;
    orderingStep.hidden = false;
    if (orderingState?.round) renderOrdering();
    else renderOrderingPreview();
    return;
  }
  if (presentationState?.screen === "listing") {
    buzzStep.hidden = true;
    orderingStep.hidden = true;
    listingStep.hidden = false;
    if (listingState?.round) renderListing();
    else renderListingPreview();
    return;
  }
  if (presentationState?.screen === "sync") {
    buzzStep.hidden = true;
    orderingStep.hidden = true;
    listingStep.hidden = true;
    renderSync();
    return;
  }
  if (!["jeopardy-board", "jeopardy-question"].includes(presentationState?.screen)) {
    showActivityWaiting();
    return;
  }
  waitingStep.hidden = true;
  orderingStep.hidden = true;
  listingStep.hidden = true;
  syncRegisterStep.hidden = true;
  syncStep.hidden = true;
  buzzStep.hidden = false;
  selectedTeamLabel.textContent = currentState.teams[selectedTeamIndex];
  const round = currentState.round;
  const isBoard = presentationState.screen === "jeopardy-board";
  const buzzOpen = !isBoard && round.open;
  const ownBuzzIndex = round.buzzes.findIndex((buzz) => buzz.teamIndex === selectedTeamIndex);
  buzzButton.classList.toggle("registered", !isBoard && ownBuzzIndex !== -1);
  buzzButton.hidden = false;
  if (!buzzOpen) {
    buzzButton.disabled = true;
    buzzButton.textContent = "INAKTIV";
    buzzStatus.textContent = "";
  } else if (ownBuzzIndex !== -1) {
    buzzButton.disabled = true;
    buzzButton.textContent = ownBuzzIndex === 0 ? "ERSTER!" : `#${ownBuzzIndex + 1}`;
    buzzStatus.textContent = `Euer Team ist Nummer ${ownBuzzIndex + 1} in der Buzzer-Reihenfolge.`;
  } else {
    buzzButton.disabled = submitting;
    buzzButton.textContent = submitting ? "WIRD GESENDET" : "BUZZ";
    buzzStatus.textContent = "";
  }
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
    orderingStatus.textContent = "";
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
  if (!playerConnected || !round || selectedTeamIndex === null || round.phase !== "active") return;
  orderingStatus.textContent = "";
  try {
    const payload = await playerCommands.ordering({
      roundId: round.id, teamsRevision: orderingState.teamsRevision,
      teamIndex: selectedTeamIndex, deviceId, order
    });
    if (payload.state) orderingState = payload.state;
    confirmStatus(orderingStatus, "✓ Gespeichert");
  } catch (error) {
    orderingStatus.textContent = error.message || "Die Spielleitung konnte nicht erreicht werden.";
    haptic([80, 40, 80]);
  }
  render();
}

function renderOrdering() {
  const round = orderingState.round;
  orderingStep.classList.remove("is-preview");
  orderingTeam.textContent = orderingState.teams[selectedTeamIndex] || "";
  orderingTitle.textContent = round.title;
  orderingPrompt.textContent = "";
  const active = round.phase === "active";
  orderingCountdown.hidden = !active;
  orderingList.hidden = !active;
  if (!active) {
    if (activeDrag) cancelDrag(false);
    orderingStatus.textContent = "";
    return;
  }
  if (activeDrag) return;
  if (orderingStatus.textContent === "Die Aufgabe ist noch nicht freigegeben.") orderingStatus.textContent = "";
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

function renderOrderingPreview() {
  if (activeDrag) cancelDrag(false);
  orderingStep.classList.add("is-preview");
  orderingTeam.textContent = currentState.teams[selectedTeamIndex] || "";
  orderingTitle.textContent = "Order Up";
  orderingPrompt.textContent = "";
  orderingCountdown.hidden = false;
  orderingCountdown.removeAttribute("data-deadline");
  orderingCountdown.textContent = "–";
  orderingList.hidden = false;
  orderingList.classList.remove("saving", "locked-pending");
  orderingList.replaceChildren();
  for (let index = 0; index < 5; index += 1) {
    const row = document.createElement("li");
    row.className = "ordering-phone-item preview-placeholder";
    row.setAttribute("aria-hidden", "true");
    const placeholder = document.createElement("span");
    placeholder.className = "preview-placeholder-bar";
    row.append(placeholder);
    orderingList.append(row);
  }
  orderingStatus.textContent = "";
}

function receiveOrderingState(nextState, shouldRender = true) {
  if (activeDrag) {
    deferredOrderingState = nextState;
    if (nextState.round?.id !== orderingState?.round?.id || nextState.round?.phase !== "active") cancelDrag();
    return;
  }
  orderingState = nextState;
  if (shouldRender) render();
}

const refreshLiveConnection = () => liveConnection?.refresh();
const connectOrderingEvents = refreshLiveConnection;

function focusListingEntry() {
  const round = listingState?.round;
  if (!round || round.phase !== "active" || round.teamSubmitted) return;
  requestAnimationFrame(() => {
    if (!listingEntry.hidden && !listingEntry.disabled && listingEntry.isConnected) {
      listingEntry.focus({ preventScroll: true });
    }
  });
}

function saveListingItems(items) {
  const round = listingState?.round;
  if (!playerConnected || !round || selectedTeamIndex === null || round.phase !== "active"
      || round.teamSubmitted) return listingSaveChain;
  const requestData = {
    roundId: round.id,
    teamsRevision: listingState.teamsRevision,
    teamIndex: selectedTeamIndex,
    items: [...items]
  };
  listingLocalItems = [...items];
  listingSaveError = "";
  listingPendingSaves += 1;
  renderListing();
  focusListingEntry();
  listingSaveChain = listingSaveChain.catch(() => undefined).then(async () => {
    const payload = await playerCommands.listing(requestData);
    if (payload.state) listingState = payload.state;
  }).catch((error) => {
    listingSaveError = error.message || "Die Spielleitung konnte nicht erreicht werden.";
    haptic([80, 40, 80]);
  }).finally(() => {
    listingPendingSaves -= 1;
    if (listingPendingSaves === 0 && listingState?.round?.id === listingLocalRoundId) {
      listingLocalItems = [...(listingState.round.teamItems || listingLocalItems)];
    }
    render();
    focusListingEntry();
  });
  return listingSaveChain;
}

function renderListing() {
  const round = listingState.round;
  listingStep.classList.remove("is-preview");
  const active = round.phase === "active";
  if (listingLocalRoundId !== round.id) {
    listingLocalRoundId = round.id;
    listingLocalItems = [...(round.teamItems || [])];
    listingPendingSaves = 0;
    listingSaveChain = Promise.resolve();
    listingSaveError = "";
  } else if (listingPendingSaves === 0 && !round.teamSubmitted) {
    listingLocalItems = [...(round.teamItems || listingLocalItems)];
  }
  listingTeam.textContent = listingState.teams[selectedTeamIndex] || "";
  listingTitle.textContent = round.title;
  listingPrompt.textContent = round.prompt;
  listingCountdown.textContent = active
    ? Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000))
    : "0";
  listingCountdown.dataset.deadline = active ? round.deadlineAt : "";
  listingForm.hidden = !active || round.teamSubmitted;
  listingItems.hidden = !active;
  if (!active) {
    listingStatus.textContent = "Eure Liste ist gesperrt.";
    listingItemCount.textContent = `${listingLocalItems.length} Einträge`;
    return;
  }
  const items = listingLocalItems;
  listingItemCount.textContent = `${items.length} Einträge`;
  listingEntry.disabled = false;
  listingAdd.disabled = false;
  listingItems.replaceChildren();
  items.forEach((text, index) => {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "listing-remove";
    remove.setAttribute("aria-label", `${text} löschen`);
    remove.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M8 3h8l1 2h4v2H3V5h4l1-2Zm-2 6h12l-1 12H7L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z"/>
      </svg>`;
    remove.disabled = round.teamSubmitted;
    remove.addEventListener("click", () => {
      saveListingItems(items.filter((_, itemIndex) => itemIndex !== index));
      focusListingEntry();
    });
    row.append(label, remove);
    listingItems.append(row);
  });
  if (listingSaveError) {
    listingStatus.textContent = listingSaveError;
  } else if (round.teamSubmitted) {
    listingStatus.textContent = "Eure Liste wurde abgegeben.";
  } else {
    listingStatus.textContent = "";
    listingStatus.classList.remove("feedback-confirmed");
  }
  focusListingEntry();
}

function renderListingPreview() {
  listingStep.classList.add("is-preview");
  listingTeam.textContent = currentState.teams[selectedTeamIndex] || "";
  listingTitle.textContent = "List It";
  listingPrompt.textContent = "Die Aufgabe wird gleich eingeblendet.";
  listingCountdown.textContent = "–";
  listingCountdown.removeAttribute("data-deadline");
  listingItemCount.textContent = "0 Einträge";
  listingForm.hidden = false;
  listingEntry.value = "";
  listingEntry.disabled = true;
  listingAdd.disabled = true;
  listingItems.hidden = false;
  listingItems.replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const row = document.createElement("li");
    row.className = "preview-placeholder";
    row.setAttribute("aria-hidden", "true");
    const placeholder = document.createElement("span");
    placeholder.className = "preview-placeholder-bar";
    row.append(placeholder);
    listingItems.append(row);
  }
  listingStatus.textContent = "Die Aufgabe ist noch nicht freigegeben.";
}

const connectListingEvents = refreshLiveConnection;

function ownSyncParticipant() { return findOwnSyncParticipant(syncState); }

function showSyncRegistration() {
  editingSyncRegistration = true;
  const own = ownSyncParticipant();
  if (own && !selectedSyncTeamId) selectedSyncTeamId = own.syncTeamId;
  if (!syncState?.syncTeams.some((team) => team.id === selectedSyncTeamId)) selectedSyncTeamId = null;
  const closed = Boolean(syncState?.rosterLocked && !own);
  const selectedTeam = syncState?.syncTeams.find((team) => team.id === selectedSyncTeamId);
  syncRegisterTeam.textContent = selectedTeam?.name || "";
  syncTeamChoices.replaceChildren();
  (syncState?.syncTeams || []).forEach((team) => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = `sync-account-choice${team.id === selectedSyncTeamId ? " selected" : ""}`;
    choice.textContent = team.name;
    choice.addEventListener("click", () => {
      selectedSyncTeamId = team.id;
      syncRegistrationStage = "name";
      showSyncRegistration();
    });
    syncTeamChoices.append(choice);
  });
  syncName.value = own?.name || "";
  syncName.disabled = closed || !selectedTeam;
  const registrationSubmit = syncRegisterForm.querySelector("button[type=submit]");
  registrationSubmit.disabled = closed || !selectedTeam;
  registrationSubmit.textContent = own?.syncTeamId === selectedSyncTeamId ? "Name speichern" : "Beitreten";
  syncTeamSelection.hidden = syncRegistrationStage !== "teams";
  syncNameSelection.hidden = syncRegistrationStage !== "name" || !selectedTeam;
  syncRegisterForm.hidden = closed || !selectedTeam;
  syncTeamCreateForm.hidden = Boolean(syncState?.rosterLocked);
  syncRegisterStatus.textContent = closed ? "Wähle dein bestehendes Spielerkonto." : "";
  syncRegisterStep.hidden = false;
  syncStep.hidden = true;
  if (syncRegistrationStage === "name") queueMicrotask(() => syncName.focus({ preventScroll: true }));
}

function renderSync() {
  const own = ownSyncParticipant();
  if (syncState?.rosterLocked && own) editingSyncRegistration = false;
  if (!syncState || !own || editingSyncRegistration) {
    showSyncRegistration();
    return;
  }
  syncRegisterStep.hidden = true;
  syncStep.hidden = false;
  const ownTeam = syncState.syncTeams.find((team) => team.id === own.syncTeamId);
  syncTeam.textContent = `${ownTeam?.name || "?"} · ${own.name}`;
  syncTeamRename.value = ownTeam?.name || "";
  syncTeamRenameForm.hidden = true;
  syncMemberActions.hidden = syncState.rosterLocked;
  const round = syncState.round;
  syncChoices.replaceChildren();
  const teammates = syncState.participants.filter((item) => item.syncTeamId === own.syncTeamId);
  const active = round?.phase === "active";
  teammates.forEach((person) => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = `sync-person-choice${round?.ownSelectionId === person.id ? " selected" : ""}`;
    choice.textContent = person.id === own.id ? `${person.name} (ich)` : person.name;
    choice.disabled = !active;
    choice.addEventListener("click", () => saveSyncVote(person.id));
    syncChoices.append(choice);
  });
  syncStep.classList.toggle("is-preview", !active);
  if (!syncState.rosterLocked) {
    syncPrompt.textContent = "Warten auf alle Mitspielenden";
    syncCountdown.textContent = "";
    syncStatus.textContent = "";
    return;
  }
  if (!round) {
    syncPrompt.textContent = "Warten auf den nächsten Prompt";
    syncCountdown.textContent = "";
    syncStatus.textContent = "";
    return;
  }
  syncPrompt.textContent = round.phase === "prepared"
    ? ""
    : round.phase === "active" ? "Wähle eine Person" : "Ergebnis";
  syncCountdown.textContent = active
    ? Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000))
    : round.phase === "prepared" ? String(round.timeLimitSeconds) : "0";
  syncStatus.textContent = "";
}

async function saveSyncVote(selectedParticipantId) {
  const round = syncState?.round;
  if (!playerConnected || !round || round.phase !== "active") return;
  try {
    const payload = await playerCommands.syncVote({ deviceId, roundId: round.id, selectedParticipantId });
    if (payload.state) syncState = payload.state;
    haptic(40);
    render();
  } catch (error) {
    syncStatus.textContent = error.message || "Die Auswahl konnte nicht gespeichert werden.";
    haptic([80, 40, 80]);
  }
}

const connectSyncEvents = refreshLiveConnection;

function reconcileLiveStreams() {
  refreshLiveConnection();
}

document.querySelector("#change-team").addEventListener("click", showTeamSelection);
document.querySelector("#waiting-change-team").addEventListener("click", showTeamSelection);
document.querySelector("#ordering-change-team").addEventListener("click", showTeamSelection);
document.querySelector("#listing-change-team").addEventListener("click", showTeamSelection);
syncEditRegistration.addEventListener("click", () => {
  selectedSyncTeamId = null;
  syncRegistrationStage = "teams";
  showSyncRegistration();
});
syncRegistrationBack.addEventListener("click", () => {
  syncRegistrationStage = "teams";
  showSyncRegistration();
});
syncRenameSelf.addEventListener("click", () => {
  selectedSyncTeamId = ownSyncParticipant()?.syncTeamId || null;
  syncRegistrationStage = "name";
  showSyncRegistration();
});
syncShowTeamRename.addEventListener("click", () => {
  syncTeamRenameForm.hidden = false;
  syncMemberActions.hidden = true;
  syncTeamRename.focus({ preventScroll: true });
});
syncCancelTeamRename.addEventListener("click", () => {
  syncTeamRenameForm.hidden = true;
  syncMemberActions.hidden = false;
});
syncTeamCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = syncTeamName.value.trim();
  if (!name) return;
  syncRegisterStatus.textContent = "Team wird erstellt …";
  try {
    const payload = await playerCommands.syncTeam({ action: "create", deviceId, name });
    if (payload.state) syncState = payload.state;
    selectedSyncTeamId = payload.syncTeamId;
    syncRegistrationStage = "name";
    syncTeamName.value = "";
    showSyncRegistration();
  } catch (error) {
    syncRegisterStatus.textContent = error.message || "Das Team konnte nicht erstellt werden.";
  }
});
syncTeamRenameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const own = ownSyncParticipant();
  const name = syncTeamRename.value.trim();
  if (!own || !name) return;
  try {
    const payload = await playerCommands.syncTeam({
      action: "rename", deviceId, syncTeamId: own.syncTeamId, name
    });
    if (payload.state) syncState = payload.state;
    render();
  } catch (error) {
    syncStatus.textContent = error.message || "Das Team konnte nicht umbenannt werden.";
  }
});
syncRegisterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = syncName.value.trim();
  if (!name || !selectedSyncTeamId || !syncState) return;
  syncRegisterStatus.textContent = "Wird registriert …";
  try {
    const payload = await playerCommands.syncRegister({
      deviceId,
      teamsRevision: syncState.teamsRevision,
      syncTeamId: selectedSyncTeamId,
      name
    });
    if (payload.state) syncState = payload.state;
    editingSyncRegistration = false;
    connectSyncEvents();
    render();
  } catch (error) {
    syncRegisterStatus.textContent = error.message || "Die Registrierung ist fehlgeschlagen.";
  }
});
listingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = listingEntry.value;
  const round = listingState?.round;
  if (!value.trim() || !round || round.teamSubmitted) return;
  const items = round.teamItems || [];
  const currentItems = listingLocalRoundId === round.id ? listingLocalItems : items;
  const appended = appendUniqueItem(currentItems, value);
  if (appended.error === "duplicate") {
    listingStatus.textContent = "Dieser Eintrag steht bereits in eurer Liste.";
    listingEntry.focus({ preventScroll: true });
    return;
  }
  if (appended.error) return;
  listingEntry.value = "";
  listingEntry.focus({ preventScroll: true });
  saveListingItems(appended.items);
});
teamLobbyCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = teamLobbyName.value.trim();
  if (!name) return;
  teamLobbyAction("create", { name }).then((created) => { if (created) teamLobbyName.value = ""; });
});
buzzButton.addEventListener("click", async () => {
  if (!playerConnected || !currentState?.round.open || selectedTeamIndex === null || submitting) return;
  submitting = true;
  let errorMessage = "";
  render();
  try {
    const result = await playerCommands.buzz({
      roundId: currentState.round.id,
      teamsRevision: currentState.teamsRevision,
      teamIndex: selectedTeamIndex,
      deviceId
    });
    if (result.state) currentState = result.state;
    haptic([70, 25, 100]);
  } catch (error) {
    if (error.payload?.state) currentState = error.payload.state;
    errorMessage = error.message || "Die Quiz-Spielleitung konnte nicht erreicht werden. Prüft die WLAN-Verbindung.";
    haptic([80, 40, 80]);
  } finally {
    submitting = false;
    render();
    if (errorMessage) buzzStatus.textContent = errorMessage;
  }
});

function setPlayerConnection(connected) {
  playerConnected = connected;
  connectionStatus.textContent = connected ? (wasConnected ? "Wieder verbunden" : "Verbunden") : "Verbindung wird wiederhergestellt…";
  connectionStatus.classList.toggle("connected", connected);
  document.body.classList.toggle("player-disconnected", !connected);
  if (connected) {
    if (wasConnected) {
      connectionStatus.classList.add("reconnected");
      setTimeout(() => {
        connectionStatus.classList.remove("reconnected");
        connectionStatus.textContent = "Verbunden";
      }, 1800);
    }
    wasConnected = true;
  }
}

liveConnection = connectPlayerSession({
  identity: () => ({ deviceId, teamIndex: selectedTeamIndex }),
  onConnectionChange: setPlayerConnection,
  onSnapshot: (snapshot) => {
    const orderingJustLocked = orderingState?.round?.phase === "active" && snapshot.ordering?.round?.phase !== "active";
    const listingJustLocked = listingState?.round?.phase === "active" && snapshot.listing?.round?.phase !== "active";
    currentState = snapshot.buzzer;
    teamLobbyState = snapshot.teamLobby;
    presentationState = snapshot.presentation;
    receiveOrderingState(snapshot.ordering, false);
    listingState = snapshot.listing;
    syncState = snapshot.sync;
    render();
    if (orderingJustLocked) confirmStatus(orderingStatus, "✓ Reihenfolge gesperrt", true);
    if (listingJustLocked) confirmStatus(listingStatus, "✓ Liste gesperrt", true);
  }
});

orderingTimer = setInterval(() => {
  if (orderingState?.round?.phase === "active") {
    const seconds = Math.max(0, Math.ceil((orderingState.round.deadlineAt - Date.now()) / 1000));
    orderingCountdown.textContent = seconds;
    if (seconds === 0 && activeDrag) {
      cancelDrag();
      orderingList.classList.add("locked-pending");
      orderingStatus.textContent = "";
    }
  }
  if (listingState?.round?.phase === "active") {
    listingCountdown.textContent = Math.max(0, Math.ceil((listingState.round.deadlineAt - Date.now()) / 1000));
  }
}, 200);

setInterval(() => {
  if (presentationState?.screen !== "sync" || syncState?.round?.phase !== "active") return;
  syncCountdown.textContent = Math.max(0, Math.ceil((syncState.round.deadlineAt - Date.now()) / 1000));
}, 100);

window.addEventListener("pagehide", () => {
  cancelDrag(false);
  liveConnection?.close();
});
