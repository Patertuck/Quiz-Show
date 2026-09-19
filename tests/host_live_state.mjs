import test from "node:test";
import assert from "node:assert/strict";


class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, data = undefined) {
    this.listeners.get(type)?.(data === undefined ? {} : { data });
  }

  close() {}
}

function snapshot(version, serverSessionId = "server-1", screen = "ordering") {
  return {
    presentation: { version: 1, serverSessionId, screen },
    ordering: { version, teams: [], completedQuestionIds: [], round: null }
  };
}

test("host subscriptions ignore unchanged game versions but retain the latest snapshot", async () => {
  globalThis.location = { protocol: "http:", host: "localhost:8000" };
  globalThis.WebSocket = MockWebSocket;

  const { subscribeHostState } = await import(`../js/host/live-state.js?test=${Date.now()}`);
  const received = [];
  const unsubscribe = subscribeHostState("ordering", (state) => received.push(state.version));
  const socket = MockWebSocket.instances.at(-1);

  socket.emit("message", JSON.stringify({ type: "snapshot", data: snapshot(4) }));
  socket.emit("message", JSON.stringify({ type: "snapshot", data: snapshot(4, "server-1", "ordering-preview") }));
  socket.emit("message", JSON.stringify({ type: "snapshot", data: snapshot(5) }));
  assert.deepEqual(received, [4, 5]);

  const cached = [];
  const unsubscribeCached = subscribeHostState("ordering", (state) => cached.push(state.version));
  await Promise.resolve();
  assert.deepEqual(cached, [5]);

  socket.emit("message", JSON.stringify({ type: "snapshot", data: snapshot(5, "server-2") }));
  assert.deepEqual(received, [4, 5, 5]);
  assert.deepEqual(cached, [5, 5]);

  unsubscribe();
  unsubscribeCached();
});
