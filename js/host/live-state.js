import { createLiveConnection } from "../live-client.js";

const subscriptions = new Map();
let latest = null;
let connection = null;
let connected = false;

function ensureConnection() {
  if (connection) return;
  connection = createLiveConnection({
    role: "host",
    onConnectionChange(value) {
      connected = value;
      subscriptions.forEach(({ onConnectionChange }) => onConnectionChange(value));
    },
    onSnapshot(snapshot) {
      latest = snapshot;
      subscriptions.forEach(({ key, onState }) => {
        if (snapshot[key] !== undefined) onState(snapshot[key], snapshot);
      });
    }
  });
}

export function subscribeHostState(key, onState, onConnectionChange = () => {}) {
  const id = Symbol(key);
  subscriptions.set(id, { key, onState, onConnectionChange });
  ensureConnection();
  onConnectionChange(connected);
  if (latest?.[key] !== undefined) queueMicrotask(() => onState(latest[key], latest));
  return () => subscriptions.delete(id);
}

export function latestHostSnapshot() {
  return latest;
}

