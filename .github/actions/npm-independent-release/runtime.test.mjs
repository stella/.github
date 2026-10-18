import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishReleaseEntries } from "../npm-publish-hardened/runtime.mjs";

import {
  buildCreateReleaseArgs,
  buildMarkLatestArgs,
  buildPublishReleaseArgs,
  listTarballs,
  releasePublishPlan,
  validateReleaseDependencies,
  MAX_NPM_VISIBILITY_TIMEOUT_MINUTES,
  resolveNpmVisibilityTimeoutMinutes,
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

test("defaults the npm visibility timeout when unset", () => {
  assert.equal(resolveNpmVisibilityTimeoutMinutes(undefined), 20);
  assert.equal(resolveNpmVisibilityTimeoutMinutes(""), 20);
});

test("parses an explicit npm visibility timeout", () => {
  assert.equal(resolveNpmVisibilityTimeoutMinutes("45"), 45);
  assert.equal(
    resolveNpmVisibilityTimeoutMinutes(
      String(MAX_NPM_VISIBILITY_TIMEOUT_MINUTES),
    ),
    MAX_NPM_VISIBILITY_TIMEOUT_MINUTES,
  );
});

test("rejects a non-positive or non-numeric npm visibility timeout", () => {
  assert.throws(
    () => resolveNpmVisibilityTimeoutMinutes("0"),
    /must be a positive number/,
  );
  assert.throws(
    () => resolveNpmVisibilityTimeoutMinutes("-5"),
    /must be a positive number/,
  );
  assert.throws(
    () => resolveNpmVisibilityTimeoutMinutes("soon"),
    /must be a positive number/,
  );
});

test("rejects a timeout the fixed job budget cannot honor", () => {
  assert.throws(
    () =>
      resolveNpmVisibilityTimeoutMinutes(
        String(MAX_NPM_VISIBILITY_TIMEOUT_MINUTES + 1),
      ),
    /no greater than 45/,
  );
  assert.throws(
    () => resolveNpmVisibilityTimeoutMinutes("46"),
    /no greater than 45/,
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
    manifest: {},
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

test("a later missing namespace prevents every draft write", async () => {
  let releaseWrites = 0;
  const entries = [
    {
      path: "ui.tgz",
      manifest: {},
      pkg: { name: "@stll/ui", version: "0.12.1" },
      registry: { exists: false },
      status: "stage-and-publish",
      tag: "@stll/ui@0.12.1",
    },
    {
      path: "chat.tgz",
      manifest: {},
      pkg: { name: "@stll/chat", version: "0.1.1" },
      registry: { exists: false },
      status: "stage-and-publish",
      tag: "@stll/chat@0.1.1",
    },
  ];

  await assert.rejects(
    stageReleaseEntries({
      createDraftRelease: () => {
        releaseWrites += 1;
      },
      entries,
      hasNpmNamespace: (name) => name === "@stll/ui",
      head: sourceSha,
      repository: "stella/example",
      temporaryDirectory: "/tmp/release",
    }),
    /@stll\/chat.*no tag or GitHub release draft was created/,
  );
  assert.equal(releaseWrites, 0);
});

test("namespace lookup errors fail closed before draft creation", async () => {
  let releaseWrites = 0;
  const entry = {
    path: "package.tgz",
    manifest: {},
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
      hasNpmNamespace: () => {
        throw new Error("npm namespace lookup failed: registry unavailable");
      },
      head: sourceSha,
      repository: "stella/example",
      temporaryDirectory: "/tmp/release",
    }),
    /registry unavailable/,
  );
  assert.equal(releaseWrites, 0);
});

test("stages an unpublished version after namespace bootstrap", async () => {
  const writes = [];
  const entry = {
    path: "package.tgz",
    manifest: {},
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

const dependencyEntry = (name, manifest = {}, registry = { exists: false }) => ({
  path: `${name.replace("/", "-")}.tgz`,
  pkg: { name, version: "1.2.3" },
  manifest: { name, version: "1.2.3", ...manifest },
  registry,
  status: registry.exists ? "complete" : "stage-and-publish",
  tag: `${name}@1.2.3`,
});

for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  test(`missing sibling ${section} refuses the entire release before any draft`, async () => {
    const writes = [];
    const lookups = [];
    await assert.rejects(
      stageReleaseEntries({
        entries: [
          dependencyEntry("@stll/independent"),
          dependencyEntry("@stll/test-kit", { [section]: { "@stll/time": "0.4.0" } }),
        ],
        hasNpmNamespace: () => true,
        readPublishedVersions: (name, version) => {
          lookups.push([name, version]);
          return [];
        },
        createNotes: () => "notes",
        createDraftRelease: (args) => writes.push(args),
      }),
      new RegExp(`@stll/test-kit@1.2.3.*${section}.*@stll/time@0.4.0.*no tag or GitHub release draft`),
    );
    assert.deepEqual(lookups, [["@stll/time", "0.4.0"]]);
    assert.deepEqual(writes, []);
  });
}

test("planned sibling version satisfies preflight and is ordered before its dependent", async () => {
  const entries = [
    dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "1.2.3" } }),
    dependencyEntry("@stll/time"),
  ];
  const writes = [];
  await stageReleaseEntries({
    entries,
    hasNpmNamespace: () => true,
    readPublishedVersions: () => assert.fail("planned version needs no registry lookup"),
    createNotes: () => "notes",
    createDraftRelease: ({ entry }) => writes.push(entry.pkg.name),
  });
  assert.equal(writes.length, 2);
  assert.deepEqual(releasePublishPlan(entries), [
    { name: "@stll/time", version: "1.2.3", path: "@stll-time.tgz", dependencies: [] },
    { name: "@stll/test-kit", version: "1.2.3", path: "@stll-test-kit.tgz", dependencies: ["@stll/time"] },
  ]);
});

test("a published exact sibling version satisfies preflight outside the plan", () => {
  const lookups = [];
  validateReleaseDependencies({
    entries: [dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "0.4.0" } })],
    readPublishedVersions: (name, specifier) => {
      lookups.push([name, specifier]);
      return ["0.4.0"];
    },
  });
  assert.deepEqual(lookups, [["@stll/time", "0.4.0"]]);
});

test("a planned package at an incompatible version does not satisfy the dependency", () => {
  assert.throws(() => validateReleaseDependencies({
    entries: [
      dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "0.4.0" } }),
      dependencyEntry("@stll/time"),
    ],
    readPublishedVersions: () => [],
  }), /@stll\/test-kit.*@stll\/time@0.4.0.*no matching version/);
});

test("a compatible published version may satisfy a dependency on a different planned version", () => {
  validateReleaseDependencies({
    entries: [
      dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "0.4.0" } }),
      dependencyEntry("@stll/time"),
    ],
    readPublishedVersions: () => ["0.4.0"],
  });
});

test("same-plan dependencies are checked across scopes and for unscoped packages", () => {
  for (const name of ["sibling", "@other/sibling"]) {
    assert.throws(() => validateReleaseDependencies({
      entries: [
        dependencyEntry("@stll/test-kit", { dependencies: { [name]: "0.4.0" } }),
        dependencyEntry(name),
      ],
      readPublishedVersions: () => [],
    }), /no matching version/);
  }
});

test("unrelated third-party dependencies are ignored", () => {
  validateReleaseDependencies({
    entries: [
      dependencyEntry("@stll/test-kit", {
        dependencies: { react: "^19.0.0", "@types/node": "*" },
        optionalDependencies: { fsevents: "~2.3.0" },
        peerDependencies: { vite: "^6 || ^7" },
      }),
      dependencyEntry("unscoped-package", { dependencies: { "other-package": "1.0.0" } }),
    ],
    readPublishedVersions: () => assert.fail("third-party dependencies must not be looked up"),
  });
});

test("range preflight accepts a compatible published or planned version", () => {
  for (const specifier of ["^1.0.0", "~1.2.0", ">=1 <2", "1.x", "^0.5.0 || ^1.0.0", "*", "1.2.0 - 1.3.0"]) {
    validateReleaseDependencies({
      entries: [
        dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": specifier } }),
        dependencyEntry("@stll/time"),
      ],
      readPublishedVersions: () => assert.fail("compatible planned range needs no lookup"),
    });
    validateReleaseDependencies({
      entries: [dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": specifier } })],
      readPublishedVersions: () => ["1.2.3"],
    });
  }
});

test("range preflight refuses incompatible and prerelease-only registry versions", () => {
  for (const versions of [[], ["2.0.0"], ["1.2.3-rc.1"]]) {
    assert.throws(() => validateReleaseDependencies({
      entries: [dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "^1.0.0" } })],
      readPublishedVersions: () => versions,
    }), /no matching version/);
  }
});

test("unsupported sibling specs fail closed", () => {
  for (const specifier of ["latest", "npm:@other/time@1.2.3", "https://example.com/time.tgz"]) {
    assert.throws(() => validateReleaseDependencies({
      entries: [dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": specifier } })],
      readPublishedVersions: () => assert.fail("unsupported spec must fail before registry lookup"),
    }), /Unsupported npm dependency range/);
  }
});

test("registry lookup failure prevents every draft", async () => {
  const writes = [];
  await assert.rejects(stageReleaseEntries({
    entries: [dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "0.4.0" } })],
    hasNpmNamespace: () => true,
    readPublishedVersions: () => { throw new Error("registry unavailable"); },
    createDraftRelease: (args) => writes.push(args),
  }), /registry unavailable/);
  assert.deepEqual(writes, []);
});

test("cycles name the packages and prevent every draft", async () => {
  const writes = [];
  await assert.rejects(stageReleaseEntries({
    entries: [
      dependencyEntry("@stll/a", { optionalDependencies: { "@stll/b": "1.2.3" } }),
      dependencyEntry("@stll/b", { peerDependencies: { "@stll/a": "1.2.3" } }),
    ],
    hasNpmNamespace: () => true,
    readPublishedVersions: () => assert.fail("cycle must fail before dependency lookup"),
    createDraftRelease: (args) => writes.push(args),
  }), /internal dependency cycle: @stll\/a, @stll\/b/);
  assert.deepEqual(writes, []);
});

test("repeated sibling checks share a registry result across packages and sections", () => {
  const lookups = [];
  validateReleaseDependencies({
    entries: [
      dependencyEntry("@stll/a", {
        dependencies: { "@stll/time": "0.4.0" },
        peerDependencies: { "@stll/time": "0.4.0" },
      }),
      dependencyEntry("@stll/b", { optionalDependencies: { "@stll/time": "0.4.0" } }),
    ],
    readPublishedVersions: (name, version) => {
      lookups.push([name, version]);
      return ["0.4.0"];
    },
  });
  assert.deepEqual(lookups, [["@stll/time", "0.4.0"]]);
});

test("published entries are not republished or dependency-checked on recovery", () => {
  validateReleaseDependencies({
    entries: [dependencyEntry("@stll/a", { dependencies: { "@stll/time": "0.4.0" } }, { exists: true })],
    readPublishedVersions: () => assert.fail("published entries need no dependency lookup"),
  });
});


test("failed sibling publication names skipped dependents and recovery publishes in dependency order", async () => {
  const entries = [
    dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "1.2.3" } }),
    dependencyEntry("@stll/time"),
    dependencyEntry("@stll/app", { peerDependencies: { "@stll/test-kit": "1.2.3" } }),
  ];
  const visible = new Set();
  const attempts = [];
  const writes = [];
  let failTime = true;
  const release = async () => {
    const current = entries.map((entry) => ({ ...entry, registry: { exists: visible.has(entry.pkg.name) } }));
    await stageReleaseEntries({
      entries: current,
      hasNpmNamespace: () => true,
      readPublishedVersions: () => [],
      createNotes: () => "notes",
      createDraftRelease: () => {},
    });
    const plan = releasePublishPlan(current.filter((entry) => !entry.registry.exists));
    await publishReleaseEntries({
      env: { PUBLISH_PLAN: JSON.stringify(plan), TARBALLS: plan.map(({ path }) => path).join("\n") },
      checkTarball: () => {},
      publishTarball: ({ EXPECTED_NAME }) => {
        attempts.push(EXPECTED_NAME);
        if (EXPECTED_NAME === "@stll/time" && failTime) throw new Error("publish failed");
        if (EXPECTED_NAME === "@stll/test-kit") assert.ok(visible.has("@stll/time"));
        if (EXPECTED_NAME === "@stll/app") assert.ok(visible.has("@stll/test-kit"));
        writes.push(EXPECTED_NAME);
      },
      waitForPackages: async ({ packages }) => { visible.add(packages[0].name); return []; },
      writeOutput: () => {},
    });
  };
  await assert.rejects(release(), /@stll\/time@1.2.3.*Skipped dependents: @stll\/test-kit, @stll\/app/);
  assert.deepEqual(attempts, ["@stll/time"]);
  assert.deepEqual(writes, []);
  failTime = false;
  await release();
  assert.deepEqual(writes, ["@stll/time", "@stll/test-kit", "@stll/app"]);
});

test("recovery omits already visible sibling tarballs and derives remaining dependency edges", () => {
  const entries = [
    dependencyEntry("@stll/time", {}, { exists: true }),
    dependencyEntry("@stll/test-kit", { dependencies: { "@stll/time": "1.2.3" } }),
    dependencyEntry("@stll/app", { dependencies: { "@stll/test-kit": "1.2.3" } }),
  ];
  validateReleaseDependencies({ entries, readPublishedVersions: () => assert.fail("matching plan needs no lookup") });
  assert.deepEqual(releasePublishPlan(entries.filter((entry) => !entry.registry.exists)), [
    { name: "@stll/test-kit", version: "1.2.3", path: "@stll-test-kit.tgz", dependencies: [] },
    { name: "@stll/app", version: "1.2.3", path: "@stll-app.tgz", dependencies: ["@stll/test-kit"] },
  ]);
});
