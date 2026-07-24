import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generatedExclusions,
  isGeneratedVersionPullRequest,
  validateChangelogOwnership,
  validateChangeset,
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

test("accepts a release finalizer when Changesets remains the changelog owner", () => {
  validateChangelogOwnership(
    ".github/workflows/release.yml",
    `jobs:
  finalize:
    uses: stella/.github/.github/workflows/npm-version-finalize.yml@immutable
    with:
      package-files: package.json
      update-changelog: false
    permissions:
      contents: write
`,
  );
});

test("rejects a release finalizer with the conflicting changelog writer enabled", () => {
  assert.throws(
    () =>
      validateChangelogOwnership(
        ".github/workflows/release.yml",
        `jobs:
  finalize:
    uses: stella/.github/.github/workflows/npm-version-finalize.yml@immutable
    with:
      package-files: package.json
`,
      ),
    /second, conflicting writer/,
  );
});

test("does not mistake another job's input for the finalizer setting", () => {
  assert.throws(
    () =>
      validateChangelogOwnership(
        ".github/workflows/release.yml",
        `jobs:
  finalize:
    uses: stella/.github/.github/workflows/npm-version-finalize.yml@immutable
    with:
      package-files: package.json
  unrelated:
    uses: owner/repository/.github/workflows/example.yml@immutable
    with:
      update-changelog: false
`,
      ),
    /second, conflicting writer/,
  );
});
