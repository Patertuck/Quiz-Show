import assert from "node:assert/strict";
import test from "node:test";

import { formatInteger } from "../js/format-number.js";

test("formats integers with a stable Swiss apostrophe separator", () => {
  assert.equal(formatInteger(0), "0");
  assert.equal(formatInteger(999), "999");
  assert.equal(formatInteger(1_000), "1'000");
  assert.equal(formatInteger(12_345_678), "12'345'678");
  assert.equal(formatInteger(-12_500), "-12'500");
});

test("rejects values that cannot be represented as point integers", () => {
  assert.throws(() => formatInteger(1.5), TypeError);
  assert.throws(() => formatInteger(Number.NaN), TypeError);
  assert.throws(() => formatInteger(Number.MAX_SAFE_INTEGER + 1), TypeError);
});
