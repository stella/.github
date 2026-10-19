import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

// `ubuntu-latest` moves to new images outside this repository and is served from a slower shared pool.
test("shared workflows and actions name an exact Ubuntu runner image", () => {
  const root = new URL("../", import.meta.url);
  const offenders = [];
  let checked = 0;
  for (const directory of ["workflows", "actions"]) {
    for (const file of readdirSync(new URL(`${directory}/`, root), { recursive: true })) {
      if (!/\.ya?ml$/.test(file)) continue;
      checked++;
      const source = readFileSync(new URL(`${directory}/${file}`, root), "utf8");
      source.split("\n").forEach((line, index) => {
        if (/\bubuntu-latest\b/.test(line)) offenders.push(`${directory}/${file}:${index + 1}`);
      });
    }
  }
  assert.ok(checked > 0);
  assert.deepEqual(offenders, []);
});
