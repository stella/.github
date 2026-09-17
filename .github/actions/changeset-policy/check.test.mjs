import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  generatedExclusions,
  isGeneratedVersionPullRequest,
  main,
  validateChangeset,
  validateChangesetVersionCommand,
} from "./check.mjs";

const packages = new Set(["@stll/core", "plain-package"]);
const EMPTY_CHANGESET = "---\n---\n";

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

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const isolatedGitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...isolatedGitEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const write = (root, path, contents) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};

// A maintenance release commit: a published package's version bump, and the
// empty changeset the policy asks for beside it, carried over from the
// previous release under the new version's name.
const releaseFixture = ({ renameChangeset }) => {
  const root = mkdtempSync(join(tmpdir(), "changeset-policy-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ".changeset/README.md", "# Changesets\n");
  write(root, ".changeset/release-v1.2.3.md", EMPTY_CHANGESET);
  write(
    root,
    "packages/core/package.json",
    '{"name":"@stll/core","version":"1.2.3"}\n',
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const baseRef = git(root, "rev-parse", "HEAD");

  if (renameChangeset) {
    git(
      root,
      "mv",
      ".changeset/release-v1.2.3.md",
      ".changeset/release-v1.2.4.md",
    );
  }
  write(
    root,
    "packages/core/package.json",
    '{"name":"@stll/core","version":"1.2.4"}\n',
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "release v1.2.4");
  return { baseRef, root };
};

const check = ({ baseRef, root }) => {
  const previous = process.cwd();
  process.chdir(root);
  try {
    main({
      BASE_REF: baseRef,
      GENERATED_PATHS: "VERSION",
      HEAD_REF: "chore/release-v1.2.4",
      HEAD_REPOSITORY: "stella/example",
      PACKAGE_FILES: "packages/core/package.json",
      PR_AUTHOR: "maintainer",
      RELEASE_PATHS: "packages/core/package.json",
      REPOSITORY: "stella/example",
      VERSION_BRANCH: "changeset-release/main",
      VERSION_FILE: "VERSION",
      VERSION_PR_AUTHOR: "stella-provenance-updater[bot]",
    });
  } finally {
    process.chdir(previous);
  }
};

test("counts a renamed empty changeset as a newly added entry", () => {
  const renamed = releaseFixture({ renameChangeset: true });
  // The regression only means anything while git still pairs the two entries
  // as one rename.
  assert.match(
    git(
      renamed.root,
      "diff",
      "--name-status",
      "--find-renames",
      renamed.baseRef,
      "HEAD",
      "--",
      ".changeset/*.md",
    ),
    /^R/mu,
  );
  check(renamed);

  assert.throws(
    () => check(releaseFixture({ renameChangeset: false })),
    /require a newly added changeset/,
  );
});
