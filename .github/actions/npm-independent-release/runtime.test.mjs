import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listTarballs, resolveSourceSha } from "./runtime.mjs";

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
