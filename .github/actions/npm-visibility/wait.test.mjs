import assert from "node:assert/strict";
import test from "node:test";

import { waitForNpmPackages } from "./wait.mjs";

const packages = [
  { name: "@stll/core", version: "1.0.0" },
  { name: "@stll/vue", version: "1.0.0" },
];

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
