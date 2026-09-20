import assert from "node:assert/strict";
import test from "node:test";

import { sendPlayerCommand } from "../js/player/commands.js";
import { clearTeamSelection, loadPlayerIdentity, saveTeamSelection } from "../js/player/identity.js";
import { appendUniqueItem } from "../js/player/listing.js";
import { moveOrder } from "../js/player/ordering.js";
import { ownSyncParticipant } from "../js/player/sync.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

test("player identity persists a stable device and optional team", () => {
  const storage = memoryStorage();
  const cryptoApi = { randomUUID: () => "phone-1" };
  assert.deepEqual(loadPlayerIdentity(storage, cryptoApi), { deviceId: "phone-1", teamSelection: null });
  saveTeamSelection({ index: 2, revision: 4 }, storage);
  assert.deepEqual(loadPlayerIdentity(storage, cryptoApi).teamSelection, { index: 2, revision: 4 });
  clearTeamSelection(storage);
  assert.equal(loadPlayerIdentity(storage, cryptoApi).teamSelection, null);
});

test("ordering moves an item without mutating its input", () => {
  const original = ["A", "B", "C"];
  assert.deepEqual(moveOrder(original, 0, 2), ["B", "C", "A"]);
  assert.deepEqual(original, ["A", "B", "C"]);
});

test("listing normalizes input, rejects duplicates, and allows unlimited entries", () => {
  assert.deepEqual(appendUniqueItem(["Bern"], " Zurich "), { items: ["Bern", "Zurich"], error: null });
  assert.equal(appendUniqueItem(["Bern"], "bern").error, "duplicate");
  assert.deepEqual(appendUniqueItem(["Bern", "Zurich"], "Basel"), {
    items: ["Bern", "Zurich", "Basel"], error: null
  });
});

test("sync finds the participant owned by the current device", () => {
  const participant = { id: "p2", name: "Ada" };
  assert.equal(ownSyncParticipant({ selfParticipantId: "p2", participants: [{ id: "p1" }, participant] }), participant);
  assert.equal(ownSyncParticipant(null), null);
});

test("player commands use the typed command envelope", async () => {
  let request;
  const result = await sendPlayerCommand("buzz", { roundId: 3 }, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ accepted: true }) };
  });
  assert.equal(request.url, "/api/player/commands");
  assert.deepEqual(JSON.parse(request.options.body), { type: "buzz", payload: { roundId: 3 } });
  assert.deepEqual(result, { accepted: true });
});

test("player command errors retain the server payload", async () => {
  await assert.rejects(
    sendPlayerCommand("buzz", {}, async () => ({
      ok: false, status: 409, json: async () => ({ error: "too late", state: { round: null } })
    })),
    (error) => error.message === "too late" && error.status === 409 && error.payload.state.round === null
  );
});
