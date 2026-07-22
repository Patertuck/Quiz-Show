const teamStep = document.querySelector("#team-step");
const buzzStep = document.querySelector("#buzz-step");
const choices = document.querySelector("#team-choices");
const selectedTeamLabel = document.querySelector("#selected-team");
const buzzButton = document.querySelector("#buzz-button");
const buzzStatus = document.querySelector("#buzz-status");
const connectionStatus = document.querySelector("#connection-status");

let currentState = null;
let selectedTeamIndex = null;
let submitting = false;
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
}

function selectTeam(index) {
  selectedTeamIndex = index;
  localStorage.setItem("quiz-buzzer-team", JSON.stringify({ index, revision: currentState.teamsRevision }));
  teamStep.hidden = true;
  buzzStep.hidden = false;
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

async function loadState() {
  const response = await fetch("/api/buzzer/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  currentState = await response.json();
  render();
}

document.querySelector("#change-team").addEventListener("click", showTeamSelection);
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
