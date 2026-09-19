import test from "node:test";
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
