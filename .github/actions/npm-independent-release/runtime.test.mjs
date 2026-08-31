import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCreateReleaseArgs,
  buildMarkLatestArgs,
  buildPublishReleaseArgs,
  listTarballs,
  resolveSourceSha,
  selectLatestReleaseEntry,
  stageReleaseEntries,
  validateGithubLatestConfiguration,
  validateGithubLatestPolicy,
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

test("missing npm namespaces stop before tag or draft creation", async () => {
  let releaseWrites = 0;
  const entry = {
    path: "package.tgz",
    pkg: { name: "@stll/chat", version: "0.1.1" },
    registry: { exists: false },
    status: "stage-and-publish",
    tag: "@stll/chat@0.1.1",
  };

  await assert.rejects(
    stageReleaseEntries({
      createDraftRelease: () => {
        releaseWrites += 1;
      },
      entries: [entry],
      hasNpmNamespace: () => false,
      head: sourceSha,
      repository: "stella/example",
      temporaryDirectory: "/tmp/release",
    }),
    /Bootstrap it and configure trusted publishing.*no tag or GitHub release draft was created/,
  );
  assert.equal(releaseWrites, 0);
});

test("stages an unpublished version after namespace bootstrap", async () => {
  const writes = [];
  const entry = {
    path: "package.tgz",
    pkg: { name: "@stll/chat", version: "0.1.1" },
    registry: { exists: false },
    status: "stage-and-publish",
    tag: "@stll/chat@0.1.1",
  };

  await stageReleaseEntries({
    createDraftRelease: (args) => writes.push(args),
    createNotes: () => "release notes",
    entries: [entry],
    hasNpmNamespace: () => true,
    head: sourceSha,
    repository: "stella/example",
    temporaryDirectory: "/tmp/release",
  });

  assert.deepEqual(writes, [
    {
      asset: "package.tgz",
      entry,
      head: sourceSha,
      notes: "release notes",
      repository: "stella/example",
      temporaryDirectory: "/tmp/release",
    },
  ]);
});

test("validates GitHub Latest policy at the action boundary", () => {
  assert.equal(validateGithubLatestPolicy("preserve"), "preserve");
  assert.equal(
    validateGithubLatestPolicy("canonical-package"),
    "canonical-package",
  );
  assert.equal(
    validateGithubLatestPolicy("newest-published-stable"),
    "newest-published-stable",
  );
  assert.throws(
    () => validateGithubLatestPolicy("latest"),
    /Invalid GitHub Latest policy/,
  );
});

test("requires an explicit package only for the canonical policy", () => {
  assert.doesNotThrow(() =>
    validateGithubLatestConfiguration({
      packageName: "@stll/core",
      policy: "canonical-package",
    }),
  );
  assert.throws(
    () =>
      validateGithubLatestConfiguration({
        packageName: "",
        policy: "canonical-package",
      }),
    /GITHUB_LATEST_PACKAGE is required/,
  );
  assert.throws(
    () =>
      validateGithubLatestConfiguration({
        packageName: "@stll/core",
        policy: "preserve",
      }),
    /requires the canonical-package/,
  );
});

test("preserves the repository Latest pointer by default", () => {
  assert.equal(
    selectLatestReleaseEntry({
      entries: [],
      head: sourceSha,
      policy: "preserve",
    }),
    null,
  );
});

test("selects the last stable release created from the release commit", () => {
  const entries = [
    {
      pkg: { version: "1.0.0" },
      tag: "@stll/old@1.0.0",
      tagTarget: githubSha,
    },
    {
      pkg: { version: "2.0.0-beta.1" },
      tag: "@stll/prerelease@2.0.0-beta.1",
      tagTarget: sourceSha,
    },
    {
      pkg: { version: "3.0.0" },
      tag: "@stll/first@3.0.0",
      tagTarget: sourceSha,
    },
    {
      pkg: { version: "4.0.0" },
      tag: "@stll/latest@4.0.0",
      tagTarget: sourceSha,
    },
  ];

  assert.equal(
    selectLatestReleaseEntry({
      entries,
      head: sourceSha,
      policy: "newest-published-stable",
    })?.tag,
    "@stll/latest@4.0.0",
  );
  assert.deepEqual(
    buildMarkLatestArgs({
      repository: "stella/example",
      tag: "@stll/latest@4.0.0",
    }),
    [
      "release",
      "edit",
      "@stll/latest@4.0.0",
      "--repo",
      "stella/example",
      "--latest=true",
    ],
  );
});

test("selects the canonical stable package independently of entry order", () => {
  const entries = [
    {
      pkg: { name: "@stll/core", version: "4.0.0" },
      status: "complete",
      tag: "@stll/core@4.0.0",
      tagTarget: githubSha,
    },
    {
      pkg: { name: "@stll/vue", version: "5.0.0" },
      status: "complete",
      tag: "@stll/vue@5.0.0",
      tagTarget: sourceSha,
    },
  ];

  for (const orderedEntries of [entries, entries.toReversed()]) {
    assert.equal(
      selectLatestReleaseEntry({
        entries: orderedEntries,
        head: sourceSha,
        packageName: "@stll/core",
        policy: "canonical-package",
      })?.tag,
      "@stll/core@4.0.0",
    );
  }
});

test("fails closed when the canonical release is missing or incomplete", () => {
  assert.throws(
    () =>
      selectLatestReleaseEntry({
        entries: [],
        head: sourceSha,
        packageName: "@stll/core",
        policy: "canonical-package",
      }),
    /matched 0 release entries/,
  );
  assert.throws(
    () =>
      selectLatestReleaseEntry({
        entries: [
          {
            pkg: { name: "@stll/core", version: "4.0.0" },
            status: "publish-draft",
            tag: "@stll/core@4.0.0",
            tagTarget: sourceSha,
          },
        ],
        head: sourceSha,
        packageName: "@stll/core",
        policy: "canonical-package",
      }),
    /is not complete/,
  );
});

test("preserves Latest when the canonical package is a prerelease", () => {
  assert.equal(
    selectLatestReleaseEntry({
      entries: [
        {
          pkg: { name: "@stll/core", version: "4.0.0-beta.1" },
          status: "complete",
          tag: "@stll/core@4.0.0-beta.1",
          tagTarget: sourceSha,
        },
      ],
      head: sourceSha,
      packageName: "@stll/core",
      policy: "canonical-package",
    }),
    null,
  );
});

test("does not promote prereleases from the release commit", () => {
  assert.equal(
    selectLatestReleaseEntry({
      entries: [
        {
          pkg: { version: "2.0.0-beta.1" },
          tag: "@stll/prerelease@2.0.0-beta.1",
          tagTarget: sourceSha,
        },
      ],
      head: sourceSha,
      policy: "newest-published-stable",
    }),
    null,
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
