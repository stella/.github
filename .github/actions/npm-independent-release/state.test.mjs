import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  changelogSection,
  classifyState,
  createPlan,
  hashBuffer,
  indexReleases,
  mapArtifacts,
  releaseNotes,
  sha256File,
  topologicalPackageNames,
  validateArtifactRun,
  validateDistTag,
} from "./state.mjs";

const packages = [
  { file: "packages/a/package.json", name: "@scope/a", version: "1.2.3" },
  { file: "packages/b/package.json", name: "@scope/b", version: "2.0.0" },
  { file: "packages/c/package.json", name: "@scope/c", version: "3.1.0" },
];

const artifact = (name, version, dependencies = {}) => ({
  path: `release/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
  sha256: `${name}-${version}`,
  manifest: { name, version, dependencies },
});

const release = (name, integrity, draft = true) => ({
  draft,
  assets: [{ name, id: 1 }],
  integrity,
});

const state = ({
  artifactName = "a-1.2.3.tgz",
  releaseAssetName = artifactName,
  assetIntegrity = null,
  draft = true,
  exists = false,
  head = "head",
  integrity = null,
  releaseExists = false,
  tagTarget = null,
} = {}) => ({
  assetIntegrity,
  expectedAssetName: artifactName,
  head,
  localIntegrity: "local",
  registry: { exists, integrity },
  release: releaseExists
    ? release(releaseAssetName, assetIntegrity, draft)
    : null,
  tagTarget,
});

test("maps exactly one tarball to every public manifest regardless of input order", () => {
  const mapped = mapArtifacts(packages, [
    artifact("@scope/c", "3.1.0"),
    artifact("@scope/a", "1.2.3"),
    artifact("@scope/b", "2.0.0"),
  ]);
  assert.deepEqual([...mapped.keys()], ["@scope/c", "@scope/a", "@scope/b"]);
  assert.equal(mapped.get("@scope/b").pkg.file, "packages/b/package.json");
});

test("indexes draft releases returned by the paginated releases endpoint", () => {
  const releases = indexReleases([
    [
      {
        id: 1,
        tag_name: "@scope/a@1.2.3",
        draft: true,
        prerelease: false,
        assets: [{ id: 2, name: "a-1.2.3.tgz" }],
      },
    ],
    [
      {
        id: 3,
        tag_name: "@scope/b@2.0.0",
        draft: false,
        prerelease: false,
        assets: [{ id: 4, name: "b-2.0.0.tgz" }],
      },
    ],
  ]);

  assert.deepEqual(releases.get("@scope/a@1.2.3"), {
    id: 1,
    draft: true,
    prerelease: false,
    assets: [{ id: 2, name: "a-1.2.3.tgz" }],
  });
  assert.equal(releases.get("@scope/b@2.0.0").draft, false);
});

test("tolerates one release repeated across an offset page boundary", () => {
  // A draft becoming visible between the two page requests shifts the boundary
  // entry down, so the same release id is returned on both pages.
  const boundary = {
    id: 7,
    tag_name: "@scope/a@1.2.3",
    draft: false,
    prerelease: false,
    assets: [{ id: 8, name: "a-1.2.3.tgz" }],
  };

  const releases = indexReleases([
    [boundary],
    [
      { ...boundary },
      {
        id: 9,
        tag_name: "@scope/b@2.0.0",
        draft: false,
        prerelease: false,
        assets: [{ id: 10, name: "b-2.0.0.tgz" }],
      },
    ],
  ]);

  assert.equal(releases.size, 2);
  assert.equal(releases.get("@scope/a@1.2.3").id, 7);
  assert.equal(releases.get("@scope/b@2.0.0").id, 9);
});


test("accepts recovery artifacts only from the same workflow and release source", () => {
  const currentRun = { path: ".github/workflows/publish.yml" };
  const artifactRun = {
    head_sha: "source",
    path: ".github/workflows/publish.yml",
  };

  assert.equal(
    validateArtifactRun({ artifactRun, currentRun, sourceSha: "source" }),
    artifactRun,
  );
  assert.throws(
    () =>
      validateArtifactRun({
        artifactRun: { ...artifactRun, head_sha: "other" },
        currentRun,
        sourceSha: "source",
      }),
    /not release commit/,
  );
  assert.throws(
    () =>
      validateArtifactRun({
        artifactRun: { ...artifactRun, path: ".github/workflows/other.yml" },
        currentRun,
        sourceSha: "source",
      }),
    /not '.github\/workflows\/publish.yml'/,
  );
});

test("rejects duplicate drafts for the same package tag", () => {
  // Two DISTINCT drafts, which is what makes the tag ambiguous. The same draft
  // seen twice is a paging artifact and is covered above.
  const draft = {
    tag_name: "@scope/a@1.2.3",
    draft: true,
    prerelease: false,
    assets: [{ id: 2, name: "a-1.2.3.tgz" }],
  };

  assert.throws(
    () => indexReleases([[{ ...draft, id: 1 }], [{ ...draft, id: 3 }]]),
    /duplicate releases/,
  );
});

test("rejects missing, duplicate, unexpected, and version-mismatched tarballs", () => {
  assert.throws(
    () => mapArtifacts(packages, [artifact("@scope/a", "1.2.3")]),
    /No tarball was provided/,
  );
  assert.throws(
    () =>
      mapArtifacts(packages, [
        artifact("@scope/a", "1.2.3"),
        artifact("@scope/a", "1.2.3"),
        artifact("@scope/b", "2.0.0"),
        artifact("@scope/c", "3.1.0"),
      ]),
    /Multiple tarballs/,
  );
  assert.throws(
    () =>
      mapArtifacts(packages, [
        artifact("@scope/a", "1.2.3"),
        artifact("@scope/b", "2.0.0"),
        artifact("@scope/missing", "1.0.0"),
      ]),
    /unexpected package/,
  );
  assert.throws(
    () =>
      mapArtifacts(packages, [
        artifact("@scope/a", "9.9.9"),
        artifact("@scope/b", "2.0.0"),
        artifact("@scope/c", "3.1.0"),
      ]),
    /expected 1.2.3/,
  );
});

test("rejects unresolved local dependency protocols in published manifests", () => {
  for (const specifier of [
    "workspace:^",
    "catalog:",
    "link:../a",
    "file:../a.tgz",
  ]) {
    assert.throws(
      () =>
        mapArtifacts(packages, [
          artifact("@scope/a", "1.2.3"),
          artifact("@scope/b", "2.0.0", { "@scope/a": specifier }),
          artifact("@scope/c", "3.1.0"),
        ]),
      /unresolved dependencies/,
    );
  }
});

test("topologically sorts internal dependencies with lexical ties", () => {
  const mapped = mapArtifacts(packages, [
    artifact("@scope/c", "3.1.0", { "@scope/b": "^2.0.0" }),
    artifact("@scope/b", "2.0.0", { "@scope/a": "^1.2.3" }),
    artifact("@scope/a", "1.2.3"),
  ]);
  assert.deepEqual(topologicalPackageNames(mapped), [
    "@scope/a",
    "@scope/b",
    "@scope/c",
  ]);

  const untied = mapArtifacts(packages, [
    artifact("@scope/c", "3.1.0"),
    artifact("@scope/b", "2.0.0"),
    artifact("@scope/a", "1.2.3"),
  ]);
  assert.deepEqual(topologicalPackageNames(untied), [
    "@scope/a",
    "@scope/b",
    "@scope/c",
  ]);
});

test("topology includes internal optional and peer dependencies", () => {
  const artifacts = [
    artifact("@scope/a", "1.2.3"),
    {
      ...artifact("@scope/b", "2.0.0"),
      manifest: {
        name: "@scope/b",
        version: "2.0.0",
        optionalDependencies: { "@scope/a": "^1.2.3" },
      },
    },
    {
      ...artifact("@scope/c", "3.1.0"),
      manifest: {
        name: "@scope/c",
        version: "3.1.0",
        peerDependencies: { "@scope/b": "^2.0.0" },
      },
    },
  ];
  assert.deepEqual(topologicalPackageNames(mapArtifacts(packages, artifacts)), [
    "@scope/a",
    "@scope/b",
    "@scope/c",
  ]);
});

test("rejects internal dependency cycles", () => {
  const mapped = mapArtifacts(packages, [
    artifact("@scope/a", "1.2.3", { "@scope/c": "^3.1.0" }),
    artifact("@scope/b", "2.0.0", { "@scope/a": "^1.2.3" }),
    artifact("@scope/c", "3.1.0", { "@scope/b": "^2.0.0" }),
  ]);
  assert.throws(
    () => topologicalPackageNames(mapped),
    /dependency cycle.*@scope\/a/,
  );
});

test("validates npm dist-tags instead of accepting versions or command syntax", () => {
  assert.equal(validateDistTag("latest"), "latest");
  assert.equal(validateDistTag("next-2"), "next-2");
  for (const invalid of ["", "1.2.3", "next tag", "--access"]) {
    assert.throws(() => validateDistTag(invalid), /Invalid npm dist-tag/);
  }
});

test("extracts an exact non-empty changelog version section", () => {
  const text = "# Changelog\n\n## 2.0.0\n\n- New.\n\n## 1.0.0\n\n- Old.\n";
  assert.equal(changelogSection(text, "2.0.0", "CHANGELOG.md"), "- New.");
  assert.throws(
    () => changelogSection(text, "3.0.0", "CHANGELOG.md"),
    /missing/,
  );
  assert.throws(
    () =>
      changelogSection("## 2.0.0\n\n## 1.0.0\n- Old", "2.0.0", "CHANGELOG.md"),
    /empty/,
  );
});

test("computes stable SHA-256 and registry-style SHA-512 checksums", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-state-"));
  const path = join(directory, "package.tgz");
  writeFileSync(path, "artifact bytes");
  assert.equal(
    sha256File(path),
    "4659fc0570122b0e0aa14f4ff7c261b1fe51795a01ba79963f462ebf40d7520d",
  );
  assert.match(
    hashBuffer("sha512", Buffer.from("artifact bytes")),
    /^sha512-[A-Za-z0-9+/]+=*$/,
  );
});

test("state machine accepts normal, resumable, repaired, and complete states", () => {
  assert.equal(classifyState(state()), "stage-and-publish");
  assert.equal(
    classifyState(
      state({
        releaseExists: true,
        tagTarget: "head",
        assetIntegrity: "local",
      }),
    ),
    "ready-to-publish",
  );
  assert.equal(
    classifyState(state({ exists: true, integrity: "npm" })),
    "repair-release",
  );
  assert.equal(
    classifyState(
      state({
        exists: true,
        integrity: "npm",
        releaseExists: true,
        tagTarget: "head",
        assetIntegrity: "npm",
      }),
    ),
    "publish-draft",
  );
  assert.equal(
    classifyState(
      state({
        exists: true,
        integrity: "npm",
        releaseExists: true,
        tagTarget: "head",
        assetIntegrity: "npm",
        draft: false,
      }),
    ),
    "complete",
  );
});

test("state machine stages a historically tagged unpublished version from its exact source", () => {
  assert.equal(
    classifyState(
      state({
        head: "historical-release-commit",
        tagTarget: "historical-release-commit",
      }),
    ),
    "stage-and-publish",
  );
});

test("state machine rejects wrong-SHA, premature public, and mismatched release assets", () => {
  assert.throws(
    () => classifyState(state({ tagTarget: "other" })),
    /not release commit/,
  );
  assert.throws(
    () =>
      classifyState(
        state({
          releaseExists: true,
          tagTarget: "head",
          assetIntegrity: "local",
          draft: false,
        }),
      ),
    /before npm publication/,
  );
  assert.throws(
    () =>
      classifyState(
        state({
          exists: true,
          integrity: "npm",
          releaseExists: true,
          tagTarget: "head",
          assetIntegrity: "different",
        }),
      ),
    /does not match npm/,
  );
  assert.throws(
    () =>
      classifyState(
        state({
          releaseAssetName: "wrong.tgz",
          releaseExists: true,
          tagTarget: "head",
          assetIntegrity: "local",
        }),
      ),
    /does not match/,
  );
});

test("complete older package versions keep their original immutable tag target", () => {
  assert.equal(
    classifyState(
      state({
        exists: true,
        integrity: "npm",
        releaseExists: true,
        tagTarget: "older-release-commit",
        assetIntegrity: "npm",
        draft: false,
      }),
    ),
    "complete",
  );
});

test("partial registry plan publishes only missing versions in dependency order", () => {
  const mapped = mapArtifacts(packages, [
    artifact("@scope/c", "3.1.0", { "@scope/b": "^2.0.0" }),
    artifact("@scope/b", "2.0.0", { "@scope/a": "^1.2.3" }),
    artifact("@scope/a", "1.2.3"),
  ]);
  const remoteStates = new Map([
    [
      "@scope/a",
      {
        registry: { exists: true, integrity: "npm-a" },
        release: release("a-1.2.3.tgz", "npm-a", false),
        assetIntegrity: "npm-a",
        tagTarget: "head",
      },
    ],
    [
      "@scope/b",
      {
        registry: { exists: false },
        release: null,
        assetIntegrity: null,
        tagTarget: null,
      },
    ],
    [
      "@scope/c",
      {
        registry: { exists: true, integrity: "npm-c" },
        release: null,
        assetIntegrity: null,
        tagTarget: null,
      },
    ],
  ]);
  const plan = createPlan({
    artifactsByName: mapped,
    head: "head",
    remoteStates,
  });
  assert.deepEqual(
    plan.entries.map(({ status }) => status),
    ["complete", "stage-and-publish", "repair-release"],
  );
  assert.deepEqual(plan.missingTarballs, ["release/b-2.0.0.tgz"]);
  assert.equal(plan.alreadyReleased, false);
});

test("repair notes explicitly avoid claiming a local rebuild is byte-identical", () => {
  const notes = releaseNotes({
    pkg: packages[0],
    section: "- Fixed.",
    status: "repair-release",
  });
  assert.match(notes, /recovered from the registry/);
  assert.match(notes, /does not claim.*local rebuild.*byte-identical/);
});
