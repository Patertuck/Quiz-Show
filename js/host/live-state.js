import { createLiveConnection } from "../live-client.js";

const subscriptions = new Map();
let latest = null;
let connection = null;
let connected = false;

function deliver(subscription, snapshot) {
  const value = snapshot?.[subscription.key];
  if (value === undefined) return;

  const version = value && typeof value === "object" ? value.version : undefined;
  if (version !== undefined) {
    const serverSessionId = snapshot.presentation?.serverSessionId || null;
    const revision = `${serverSessionId}:${version}`;
    if (subscription.revision === revision) return;
    subscription.revision = revision;
  }

  subscription.onState(value, snapshot);
}

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
      subscriptions.forEach((subscription) => deliver(subscription, snapshot));
    }
  });
}

export function subscribeHostState(key, onState, onConnectionChange = () => {}) {
  const id = Symbol(key);
  const subscription = { key, onState, onConnectionChange, revision: undefined };
  subscriptions.set(id, subscription);
  ensureConnection();
  onConnectionChange(connected);
  if (latest?.[key] !== undefined) {
    queueMicrotask(() => {
      if (subscriptions.get(id) === subscription) deliver(subscription, latest);
    });
  }
  return () => subscriptions.delete(id);
}

export function latestHostSnapshot() {
  return latest;
}
