import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCreateReleaseArgs,
  buildPublishReleaseArgs,
  listTarballs,
  resolveSourceSha,
  waitForStagedState,
} from "./runtime.mjs";

const githubSha = "1".repeat(40);
const sourceSha = "2".repeat(40);

const assertLatestIsDisabled = (args) => {
  assert.deepEqual(
    args.filter((argument) => argument.startsWith("--latest")),
    ["--latest=false"],
  );
};

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

test("creates package drafts without claiming GitHub latest", () => {
  const args = buildCreateReleaseArgs({
    asset: "package.tgz",
    notesPath: "/tmp/release-notes.md",
    packageVersion: "1.2.3",
    repository: "stella/example",
    tag: "@stll/example@1.2.3",
  });

  assertLatestIsDisabled(args);
  assert.ok(args.includes("--draft"));
});

test("publishes package drafts without claiming GitHub latest", () => {
  const args = buildPublishReleaseArgs({
    repository: "stella/example",
    tag: "@stll/example@1.2.3",
  });

  assertLatestIsDisabled(args);
  assert.ok(args.includes("--draft=false"));
});

test("discovers a single artifact extracted into the download directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-artifacts-flat-"));
  const tarball = join(directory, "package.tgz");
  writeFileSync(tarball, "artifact");

  assert.deepEqual(listTarballs(directory, 1), [tarball]);
});

test("discovers one tarball within every nested artifact directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-artifacts-nested-"));
  const firstArtifact = join(directory, "npm-tarball-a");
  const secondArtifact = join(directory, "npm-tarball-b", "package");
  mkdirSync(firstArtifact);
  mkdirSync(secondArtifact, { recursive: true });
  const firstTarball = join(firstArtifact, "a.tgz");
  const secondTarball = join(secondArtifact, "b.tgz");
  writeFileSync(firstTarball, "a");
  writeFileSync(secondTarball, "b");

  assert.deepEqual(listTarballs(directory, 2), [
    firstTarball,
    secondTarball,
  ]);
});

test("preserves artifact count and one-tarball-per-artifact invariants", () => {
  const flat = mkdtempSync(join(tmpdir(), "release-artifacts-flat-many-"));
  writeFileSync(join(flat, "a.tgz"), "a");
  writeFileSync(join(flat, "b.tgz"), "b");
  assert.throws(
    () => listTarballs(flat, 1),
    /must contain exactly one \.tgz; found 2/,
  );
  assert.throws(
    () => listTarballs(flat, 2),
    /separate directories.*flat artifact layout/,
  );

  const nested = mkdtempSync(join(tmpdir(), "release-artifacts-missing-"));
  mkdirSync(join(nested, "npm-tarball-a"));
  assert.throws(
    () => listTarballs(nested, 2),
    /Expected 2 package artifacts; downloaded 1/,
  );
});

const releaseState = (status) => ({
  plan: {
    entries: [{ status, tag: "@stll/example@1.0.0" }],
  },
});

test("rechecks release state until a created draft becomes visible", async () => {
  const states = [
    releaseState("stage-and-publish"),
    releaseState("stage-and-publish"),
    releaseState("publish-draft"),
  ];
  const waits = [];

  const result = await waitForStagedState({
    loadState: () => states.shift(),
    recheckDelays: [10, 20, 40],
    wait: (delay) => {
      waits.push(delay);
    },
  });

  assert.equal(result.plan.entries[0].status, "publish-draft");
  assert.deepEqual(waits, [10, 20]);
  assert.equal(states.length, 0);
});

test("keeps an unresolved staged release after bounded retries", async () => {
  let reads = 0;
  const waits = [];

  const result = await waitForStagedState({
    loadState: () => {
      reads += 1;
      return releaseState("repair-release");
    },
    recheckDelays: [10, 20],
    wait: (delay) => {
      waits.push(delay);
    },
  });

  assert.equal(result.plan.entries[0].status, "repair-release");
  assert.equal(reads, 3);
  assert.deepEqual(waits, [10, 20]);
});
