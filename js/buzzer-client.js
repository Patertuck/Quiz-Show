async function request(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export function connectToBuzzer(onState, onConnectionChange = () => {}) {
  const events = new EventSource("/api/buzzer/events");
  events.addEventListener("state", (event) => {
    onConnectionChange(true);
    onState(JSON.parse(event.data));
  });
  events.addEventListener("error", () => onConnectionChange(false));
  request("/api/buzzer/state", { cache: "no-store" }).then(onState).catch(() => onConnectionChange(false));
  return () => events.close();
}

export function controlBuzzer(action, details = {}) {
  return request("/api/buzzer/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...details })
  });
}
