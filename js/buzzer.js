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
const newDeviceId = () => crypto.randomUUID?.()
  || Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("");
const deviceId = localStorage.getItem("quiz-buzzer-device") || newDeviceId();
localStorage.setItem("quiz-buzzer-device", deviceId);

function savedSelection() {
  try { return JSON.parse(localStorage.getItem("quiz-buzzer-team")); }
  catch { return null; }
}

function showTeamSelection() {
  selectedTeamIndex = null;
  localStorage.removeItem("quiz-buzzer-team");
  teamStep.hidden = false;
  buzzStep.hidden = true;
  orderingStep.hidden = true;
  connectOrderingEvents();
}

function selectTeam(index) {
  selectedTeamIndex = index;
  localStorage.setItem("quiz-buzzer-team", JSON.stringify({ index, revision: currentState.teamsRevision }));
  teamStep.hidden = true;
  buzzStep.hidden = false;
  connectOrderingEvents();
  render();
}

function renderTeams() {
  choices.replaceChildren();
  if (!currentState?.teams.length) {
    const message = document.createElement("p");
    message.textContent = "No teams are available yet. Ask the host to start the game.";
    choices.append(message);
    return;
  }
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
  if (selectedTeamIndex === null) return;

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
    orderingStatus.textContent = "Time is up. Your answer is locked.";
    return;
  }
  orderingCountdown.dataset.deadline = round.deadlineAt;
  orderingCountdown.textContent = Math.max(0, Math.ceil((round.deadlineAt - Date.now()) / 1000));
  const order = round.teamOrder || round.shuffledItems.map((item) => item.id);
  const text = new Map(round.shuffledItems.map((item) => [item.id, item.text]));
  orderingList.replaceChildren();
  order.forEach((id, index) => {
    const row = document.createElement("li");
    row.className = "ordering-phone-item";
    row.dataset.index = index;
    const label = document.createElement("span"); label.className = "ordering-item-text"; label.textContent = text.get(id);
    const controls = document.createElement("span"); controls.className = "ordering-moves";
    const up = document.createElement("button"); up.type = "button"; up.textContent = "▲"; up.disabled = index === 0; up.setAttribute("aria-label", `Move ${text.get(id)} up`);
    const down = document.createElement("button"); down.type = "button"; down.textContent = "▼"; down.disabled = index === order.length - 1; down.setAttribute("aria-label", `Move ${text.get(id)} down`);
    up.addEventListener("click", () => submitOrder(moveOrder(order, index, index - 1)));
    down.addEventListener("click", () => submitOrder(moveOrder(order, index, index + 1)));
    controls.append(up, down); row.append(label, controls); orderingList.append(row);
    row.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      row.setPointerCapture(event.pointerId); row.classList.add("dragging");
      const start = index;
      const finish = (upEvent) => {
        row.classList.remove("dragging");
        const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest(".ordering-phone-item");
        if (target) submitOrder(moveOrder(order, start, Number(target.dataset.index)));
      };
      row.addEventListener("pointerup", finish, { once: true });
      row.addEventListener("pointercancel", () => row.classList.remove("dragging"), { once: true });
    });
  });
}

function connectOrderingEvents() {
  orderingEvents?.close();
  const query = selectedTeamIndex === null ? "" : `?teamIndex=${selectedTeamIndex}`;
  orderingEvents = new EventSource(`/api/ordering/events${query}`);
  orderingEvents.addEventListener("state", (event) => {
    orderingState = JSON.parse(event.data);
    render();
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
  buzzStatus.textContent = "Could not reach the quiz host. Check the Wi-Fi connection.";
});

connectOrderingEvents();
orderingTimer = setInterval(() => {
  if (!orderingState?.round || orderingState.round.phase !== "active") return;
  orderingCountdown.textContent = Math.max(0, Math.ceil((orderingState.round.deadlineAt - Date.now()) / 1000));
}, 200);
