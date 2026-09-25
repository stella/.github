import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNpmVisibilityRecheckDelays,
  waitForNpmPackages,
} from "./wait.mjs";

const packages = [
  { name: "@stll/core", version: "1.0.0" },
  { name: "@stll/vue", version: "1.0.0" },
];

const sum = (values) => values.reduce((total, value) => total + value, 0);

test("builds a short ramp-up then a flat 60s poll for the default 20-minute budget", () => {
  const delays = buildNpmVisibilityRecheckDelays(20);

  assert.deepEqual(delays.slice(0, 4), [5_000, 10_000, 15_000, 30_000]);
  assert.ok(delays.slice(4).every((delay) => delay === 60_000));
  assert.ok(sum(delays) <= 20 * 60_000);
  // A budget this size should reach the old 5-minute cap and keep polling.
  assert.ok(sum(delays) > 5 * 60_000);
});

test("trims the ramp-up to fit a budget smaller than a single poll interval", () => {
  const delays = buildNpmVisibilityRecheckDelays(1);

  assert.deepEqual(delays, [5_000, 10_000, 15_000, 30_000]);
  assert.equal(sum(delays), 60_000);
});

test("never schedules a delay that would overrun the budget", () => {
  for (const minutes of [0.05, 0.5, 2, 7, 20, 45]) {
    const delays = buildNpmVisibilityRecheckDelays(minutes);
    assert.ok(sum(delays) <= minutes * 60_000);
  }
});

test("waits beyond the old 75-second budget for registry propagation", async () => {
  let elapsed = 0;
  const missing = await waitForNpmPackages({
    packages,
    readNpmState: (name) => ({
      exists: name === "@stll/core" || elapsed >= 120_000,
    }),
    wait: (delay) => {
      elapsed += delay;
    },
  });

  assert.deepEqual(missing, []);
  assert.ok(elapsed >= 120_000);
});

test("honors an explicit timeout budget instead of the default", async () => {
  let elapsed = 0;
  const missing = await waitForNpmPackages({
    packages,
    readNpmState: () => ({ exists: false }),
    timeoutMinutes: 1,
    wait: (delay) => {
      elapsed += delay;
    },
  });

  assert.deepEqual(missing, packages);
  assert.equal(elapsed, 60_000);
});

test("rechecks only versions still missing and reports bounded failures", async () => {
  const reads = new Map();
  const missing = await waitForNpmPackages({
    packages,
    readNpmState: (name) => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return { exists: name === "@stll/core" };
    },
    recheckDelays: [10, 20],
    wait: () => {},
  });

  assert.deepEqual(missing, [packages[1]]);
  assert.equal(reads.get("@stll/core"), 1);
  assert.equal(reads.get("@stll/vue"), 3);
});
