import { hostFetch } from "./slot-api.js";
import { subscribeHostState } from "./host/live-state.js";

async function request(path, options = {}) {
  const response = await hostFetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export function connectToBuzzer(onState, onConnectionChange = () => {}) {
  return subscribeHostState("buzzer", onState, onConnectionChange);
}

export function controlBuzzer(action, details = {}) {
  return request("/api/buzzer/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...details })
  });
}
