import assert from "node:assert/strict";
import test from "node:test";

import { resolveSourceSha } from "./runtime.mjs";

const githubSha = "1".repeat(40);
const sourceSha = "2".repeat(40);

test("defaults release provenance to GITHUB_SHA", () => {
  assert.equal(resolveSourceSha({ githubSha }), githubSha);
});

test("prefers an explicitly resolved source SHA", () => {
  assert.equal(resolveSourceSha({ githubSha, sourceSha }), sourceSha);
});

test("rejects refs and abbreviated SHAs at the action boundary", () => {
  assert.throws(
    () => resolveSourceSha({ githubSha, sourceSha: "v1.2.3" }),
    /full lowercase commit SHA/,
  );
});
