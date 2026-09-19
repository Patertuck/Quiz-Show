const DEVICE_KEY = "quiz-buzzer-device";
const TEAM_KEY = "quiz-buzzer-team";

function newDeviceId(cryptoApi) {
  return cryptoApi.randomUUID?.()
    || Array.from(cryptoApi.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("");
}

export function loadPlayerIdentity(storage = localStorage, cryptoApi = crypto) {
  const deviceId = storage.getItem(DEVICE_KEY) || newDeviceId(cryptoApi);
  storage.setItem(DEVICE_KEY, deviceId);
  let teamSelection = null;
  try { teamSelection = JSON.parse(storage.getItem(TEAM_KEY)); }
  catch { /* Ignore obsolete or corrupted browser state. */ }
  return { deviceId, teamSelection };
}

export function saveTeamSelection(selection, storage = localStorage) {
  storage.setItem(TEAM_KEY, JSON.stringify(selection));
}

export function clearTeamSelection(storage = localStorage) {
  storage.removeItem(TEAM_KEY);
}
