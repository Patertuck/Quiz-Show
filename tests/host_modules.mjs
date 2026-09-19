import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

import { createHostRoutes } from "../js/host/routes.js";


test("host routes use one consistent controller contract", () => {
  const controller = { mount() {} };
  const routes = createHostRoutes({
    setup: controller,
    master: controller,
    start: controller,
    hub: controller,
    victory: controller,
    games: {
      jeopardy: controller,
      ordering: controller,
      listing: controller,
      sync: controller
    }
  });

  assert.deepEqual(Object.keys(routes), [
    "master", "start", "setup", "hub", "jeopardy", "ordering", "listing", "sync", "victory"
  ]);
  for (const route of Object.values(routes)) {
    assert.equal(typeof route.controller.mount, "function");
    assert.equal(typeof route.template, "string");
  }
  assert.equal(routes.listing.gameId, "listing");
  assert.equal(routes.master.requiresConfig, false);
});

test("Sync Up renders control responses without creating a WebSocket mutation loop", async () => {
  const source = await readFile(new URL("../js/games/sync.js", import.meta.url), "utf8");
  assert.match(source, /if \(isSyncSnapshot\(payload\)\) render\(payload\)/);
  const subscription = source.match(/subscribeHostState\("sync",[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.doesNotMatch(subscription, /publishSync/);
});
