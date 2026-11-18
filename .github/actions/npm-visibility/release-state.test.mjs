import assert from "node:assert/strict";
import test from "node:test";

import {
  NPM_RELEASE_STATE,
  compareReleaseVersions,
  decideNpmReleaseState,
  readNpmVisibility,
  releaseTagFor,
  releaseVersionFromTag,
} from "./release-state.mjs";

const name = "@stll/aho-corasick-wasm";
const version = "2.0.1";
const respond = (body, status) => ({ status: 0, stdout: `${body}\n${status}`, stderr: "" });

test("release tags round-trip only for the version tag scheme", () => {
  for (const candidate of ["1.2.3", "0.0.1", "2.0.0-alpha.1", "2.0.0-beta.12", "10.0.0-rc.0"]) {
    assert.equal(releaseVersionFromTag(releaseTagFor(candidate)), candidate);
  }
  for (const tag of ["1.2.3", "v1.2", "v1.2.3-next.1", "@stll/core@1.2.3", "v1.2.3 ", "release-1.2.3", null]) {
    assert.equal(releaseVersionFromTag(tag), null, String(tag));
  }
});

test("release versions order by semver with prereleases before the release", () => {
  const ordered = ["1.9.0", "1.10.0-alpha.2", "1.10.0-alpha.10", "1.10.0-beta.1", "1.10.0-rc.1", "1.10.0", "1.10.1", "2.0.0"];
  const shuffled = [...ordered].reverse();
  assert.deepEqual(shuffled.sort(compareReleaseVersions), ordered);
});

test("reads the abbreviated package document and asks caches to revalidate", () => {
  const calls = [];
  const state = readNpmVisibility(name, version, (command, args) => {
    calls.push([command, args]);
    return respond(JSON.stringify({ versions: { [version]: {} } }), 200);
  });
  assert.deepEqual(state, { exists: true });
  assert.equal(calls.length, 1);
  const [command, args] = calls[0];
  assert.equal(command, "curl");
  assert.equal(args.at(-1), "https://registry.npmjs.org/@stll%2Faho-corasick-wasm");
  assert.ok(args.includes("Cache-Control: no-cache"));
  assert.ok(args.includes("Accept: application/vnd.npm.install-v1+json"));
});

for (const [label, result, expected] of [
  ["a document without the version", respond(JSON.stringify({ versions: { "2.0.0": {} } }), 200), { exists: false }],
  ["an unknown package", respond("{}", 404), { exists: false }],
]) {
  test(`reports ${label} as not visible`, () => {
    assert.deepEqual(readNpmVisibility(name, version, () => result), expected);
  });
}

for (const [label, result] of [
  ["a network failure", { status: 6, stdout: "", stderr: "Could not resolve host" }],
  ["a server error", respond("unavailable", 503)],
  ["unreadable JSON", respond("<html>", 200)],
]) {
  test(`reports ${label} as not visible with the reason`, () => {
    const state = readNpmVisibility(name, version, () => result);
    assert.equal(state.exists, false);
    assert.equal(typeof state.error, "string");
  });
}

const pending = [{ name, version }];

test("finalizer publishes the GitHub release once npm lists every version", () => {
  for (const publishOutcome of ["success", "skipped"]) {
    assert.deepEqual(decideNpmReleaseState({ publishOutcome, missing: [] }), {
      state: NPM_RELEASE_STATE.visible,
    });
  }
});

test("finalizer keeps the draft and succeeds when npm accepted but does not list a version yet", () => {
  assert.deepEqual(decideNpmReleaseState({ publishOutcome: "success", missing: pending }), {
    state: NPM_RELEASE_STATE.pending,
    pending,
  });
});

test("finalizer fails when the npm publish did not complete", () => {
  for (const publishOutcome of ["failure", "cancelled", "", undefined]) {
    for (const missing of [[], pending]) {
      assert.throws(() => decideNpmReleaseState({ publishOutcome, missing }), /cannot be finalized/);
    }
  }
});
