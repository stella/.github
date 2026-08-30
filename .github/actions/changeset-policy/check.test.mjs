import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generatedExclusions,
  isGeneratedVersionPullRequest,
  validateChangeset,
  validateChangesetVersionCommand,
} from "./check.mjs";

const packages = new Set(["@stll/core", "plain-package"]);

test("accepts quoted and unquoted package names", () => {
  validateChangeset(
    ".changeset/valid.md",
    '---\n"@stll/core": patch\nplain-package: minor\n---\n\nDescribe the release.',
    packages,
  );
});

test("accepts an explicit empty changeset", () => {
  validateChangeset(".changeset/empty.md", "---\n---\n", packages);
});

test("rejects unknown packages", () => {
  assert.throws(
    () =>
      validateChangeset(
        ".changeset/unknown.md",
        '---\n"@stll/missing": patch\n---\n\nSummary.',
        packages,
      ),
    /unknown or non-publishable package/,
  );
});

test("rejects malformed release lines", () => {
  assert.throws(
    () =>
      validateChangeset(
        ".changeset/malformed.md",
        '---\n"@stll/core" patch\n---\n\nSummary.',
        packages,
      ),
    /malformed release frontmatter/,
  );
});

test("generated version PR requires exact identity and no unexpected files", () => {
  const environment = {
    HEAD_REF: "changeset-release/main",
    HEAD_REPOSITORY: "stella/example",
    PR_AUTHOR: "stella-provenance-updater[bot]",
    REPOSITORY: "stella/example",
    VERSION_BRANCH: "changeset-release/main",
    VERSION_FILE: "VERSION",
    VERSION_PR_AUTHOR: "stella-provenance-updater[bot]",
  };
  assert.equal(
    isGeneratedVersionPullRequest({
      changedFiles: ["VERSION", "package.json"],
      environment,
      unexpectedFiles: [],
    }),
    true,
  );
  assert.equal(
    isGeneratedVersionPullRequest({
      changedFiles: ["VERSION", "src/index.ts"],
      environment,
      unexpectedFiles: ["src/index.ts"],
    }),
    false,
  );
});

test("generated version exclusions stay rooted and include consumed changesets", () => {
  assert.deepEqual(
    generatedExclusions(["VERSION", "packages/*/package.json"], ".changeset/*.md"),
    [
      ":(top,exclude)VERSION",
      ":(top,exclude)packages/*/package.json",
      ":(top,exclude).changeset/*.md",
    ],
  );
});

test("accepts lock-preserving changeset version commands", () => {
  validateChangesetVersionCommand(
    "package.json",
    "changeset version && node scripts/sync-changeset-version.mjs",
  );
  validateChangesetVersionCommand(
    "package.json",
    "changeset version && bun install --frozen-lockfile",
  );
});

test("rejects deleting a Bun lockfile during changeset versioning", () => {
  assert.throws(
    () =>
      validateChangesetVersionCommand(
        "package.json",
        "changeset version && rm -f bun.lock && bun install",
      ),
    /must not delete bun\.lock or bun\.lockb/,
  );
  assert.throws(
    () =>
      validateChangesetVersionCommand(
        "package.json",
        "changeset version; Remove-Item ./bun.lockb",
      ),
    /must not delete bun\.lock or bun\.lockb/,
  );
});

test("rejects Bun lockfile regeneration during changeset versioning", () => {
  assert.throws(
    () =>
      validateChangesetVersionCommand(
        "package.json",
        "changeset version && bun install",
      ),
    /must not regenerate the Bun lockfile/,
  );
  assert.throws(
    () =>
      validateChangesetVersionCommand(
        "package.json",
        "bun install --frozen-lockfile && changeset version && bun i",
      ),
    /must not regenerate the Bun lockfile/,
  );
});
