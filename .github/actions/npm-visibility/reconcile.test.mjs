import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RECONCILE_OUTCOME,
  createGitHubClient,
  reconcileDraft,
  reconcileFailed,
  resolveMaxPendingHours,
  runReconcile,
  selectReconcileCandidates,
} from "./reconcile.mjs";

const repository = "stella/aho-corasick";
const commit = "0123456789abcdef0123456789abcdef01234567";
const now = Date.parse("2026-11-04T12:00:00Z");
const hoursAgo = (hours) => new Date(now - hours * 3_600_000).toISOString();
const packageFiles = ["package.json", "wasm/package.json", "tooling/package.json"];
const manifests = (version) => ({
  "package.json": { name: "@stll/aho-corasick", version },
  "wasm/package.json": { name: "@stll/aho-corasick-wasm", version },
  "tooling/package.json": { name: "tooling", version: "0.0.0", private: true },
});

const release = (tag, overrides = {}) => ({
  id: Number(tag.replace(/\D/g, "")),
  tag_name: tag,
  draft: true,
  created_at: hoursAgo(1),
  ...overrides,
});

const draftFor = (version, createdAt = hoursAgo(1)) => ({
  id: 7,
  tag: `v${version}`,
  version,
  createdAt,
});

const fakeGitHub = ({ tagCommit = commit, onBranch = true, files = manifests("2.0.1") } = {}) => {
  const published = [];
  const calls = [];
  return {
    published,
    calls,
    defaultBranch: () => "main",
    tagCommit: (tag) => {
      calls.push(["tagCommit", tag]);
      return tagCommit;
    },
    isCommitOnBranch: (sha, branch) => {
      calls.push(["isCommitOnBranch", sha, branch]);
      return onBranch;
    },
    readFile: (path, sha) => {
      calls.push(["readFile", path, sha]);
      return path in files ? JSON.stringify(files[path]) : null;
    },
    publishRelease: (id) => published.push(id),
  };
};

const visibleExcept =
  (...missing) =>
  (name) => ({ exists: !missing.includes(name) });

const decide = ({ draft = draftFor("2.0.1"), github = fakeGitHub(), readNpm = visibleExcept(), maxPendingHours = 24 } = {}) =>
  reconcileDraft({ draft, defaultBranch: "main", packageFiles, maxPendingHours, now, github, readNpm });

test("selects drafts on the version tag scheme, oldest version first, once each", () => {
  const releases = [
    release("v2.0.2"),
    release("v2.0.1"),
    release("v2.0.0", { draft: false }),
    release("v2.1.0-rc.1"),
    release("@stll/core@1.0.0", { id: 900 }),
    release("v2.0", { id: 901 }),
    release("nightly", { id: 902 }),
    // The paginated endpoint can return one release on two pages.
    release("v2.0.1"),
  ];
  assert.deepEqual(
    selectReconcileCandidates(releases).map((candidate) => candidate.tag),
    ["v2.0.1", "v2.0.2", "v2.1.0-rc.1"],
  );
});

test("publishes a draft once npm lists every public package version", () => {
  const github = fakeGitHub();
  const reads = [];
  const result = decide({
    github,
    readNpm: (name, version) => {
      reads.push(`${name}@${version}`);
      return { exists: true };
    },
  });
  assert.equal(result.outcome, RECONCILE_OUTCOME.published);
  assert.deepEqual(github.published, [7]);
  assert.deepEqual(reads, ["@stll/aho-corasick@2.0.1", "@stll/aho-corasick-wasm@2.0.1"]);
  const fileReads = github.calls.filter(([kind]) => kind === "readFile");
  assert.deepEqual(fileReads.map(([, path]) => path), packageFiles);
  assert.ok(fileReads.every(([, , sha]) => sha === commit), "manifests are read at the tagged commit");
});

test("keeps a draft that npm does not fully list within the bound", () => {
  const github = fakeGitHub();
  const result = decide({ github, readNpm: visibleExcept("@stll/aho-corasick-wasm") });
  assert.equal(result.outcome, RECONCILE_OUTCOME.pending);
  assert.deepEqual(result.missing.map((pkg) => pkg.name), ["@stll/aho-corasick-wasm"]);
  assert.deepEqual(github.published, []);
  assert.equal(reconcileFailed([result]), false);
});

test("fails the run once a draft stays incomplete past the bound", () => {
  const github = fakeGitHub();
  const result = decide({
    draft: draftFor("2.0.1", hoursAgo(25)),
    github,
    readNpm: visibleExcept("@stll/aho-corasick-wasm"),
  });
  assert.equal(result.outcome, RECONCILE_OUTCOME.overdue);
  assert.match(result.detail, /@stll\/aho-corasick-wasm@2\.0\.1/);
  assert.deepEqual(github.published, []);
  assert.equal(reconcileFailed([result]), true);
});

test("an overdue draft is still published as soon as npm lists everything", () => {
  const github = fakeGitHub();
  const result = decide({ draft: draftFor("2.0.1", hoursAgo(24 * 6)), github });
  assert.equal(result.outcome, RECONCILE_OUTCOME.published);
  assert.deepEqual(github.published, [7]);
});

test("a registry read error leaves the draft unpublished and names the reason", () => {
  const github = fakeGitHub();
  const result = decide({
    github,
    readNpm: (name) =>
      name === "@stll/aho-corasick" ? { exists: false, error: "registry answered HTTP 503" } : { exists: true },
  });
  assert.equal(result.outcome, RECONCILE_OUTCOME.pending);
  assert.match(result.detail, /HTTP 503/);
  assert.deepEqual(github.published, []);
});

test("never publishes a tag outside the default branch, and fails the run", () => {
  const github = fakeGitHub({ onBranch: false });
  const result = decide({ github, readNpm: () => assert.fail("npm must not be read") });
  assert.equal(result.outcome, RECONCILE_OUTCOME.blocked);
  assert.deepEqual(github.published, []);
  assert.equal(reconcileFailed([result]), true);
});

test("skips a draft without a tag; the finalizer always tags before staging", () => {
  const github = fakeGitHub({ tagCommit: null });
  const result = decide({ github, readNpm: () => assert.fail("npm must not be read") });
  assert.equal(result.outcome, RECONCILE_OUTCOME.untagged);
  assert.deepEqual(github.published, []);
  assert.equal(reconcileFailed([result]), false);
});

for (const [label, files] of [
  ["a manifest version that differs from the tag", manifests("2.0.0")],
  ["a package file missing at the tag", { "package.json": manifests("2.0.1")["package.json"] }],
  ["a manifest without a name", { ...manifests("2.0.1"), "package.json": { version: "2.0.1" } }],
  [
    "only private manifests",
    Object.fromEntries(packageFiles.map((file) => [file, { name: file, version: "2.0.1", private: true }])),
  ],
]) {
  test(`blocks ${label}`, () => {
    const github = fakeGitHub({ files });
    const result = decide({ github });
    assert.equal(result.outcome, RECONCILE_OUTCOME.blocked);
    assert.deepEqual(github.published, []);
  });
}

test("publishes exactly when the tag is on the default branch and npm lists every version", () => {
  const packageNames = ["@stll/aho-corasick", "@stll/aho-corasick-wasm"];
  for (const tagCommit of [commit, null]) {
    for (const onBranch of [true, false]) {
      for (let mask = 0; mask < 2 ** packageNames.length; mask += 1) {
        for (const ageHours of [0.5, 48]) {
          const unlisted = packageNames.filter((_, index) => (mask & (1 << index)) !== 0);
          const github = fakeGitHub({ tagCommit, onBranch });
          const result = decide({
            draft: draftFor("2.0.1", hoursAgo(ageHours)),
            github,
            readNpm: visibleExcept(...unlisted),
          });
          const shouldPublish = tagCommit !== null && onBranch && unlisted.length === 0;
          assert.equal(github.published.length, shouldPublish ? 1 : 0, JSON.stringify({ tagCommit, onBranch, unlisted, ageHours }));
          assert.equal(result.outcome === RECONCILE_OUTCOME.published, shouldPublish);
        }
      }
    }
  }
});

test("validates the pending bound", () => {
  assert.equal(resolveMaxPendingHours(undefined), 24);
  assert.equal(resolveMaxPendingHours("6"), 6);
  for (const value of ["0", "-1", "soon", "Infinity"]) {
    assert.throws(() => resolveMaxPendingHours(value), /positive number/);
  }
});

const notFound = () => Object.assign(new Error("gh failed"), { stderr: "gh: Not Found (HTTP 404)" });

test("the GitHub client follows annotated tags to their commit", () => {
  const responses = new Map([
    [`repos/${repository}/git/ref/tags/v2.0.1`, { object: { type: "tag", sha: "a".repeat(40) } }],
    [`repos/${repository}/git/tags/${"a".repeat(40)}`, { object: { type: "commit", sha: commit } }],
  ]);
  const client = createGitHubClient({
    repository,
    gh: (args) => JSON.stringify(responses.get(args.at(-1))),
  });
  assert.equal(client.tagCommit("v2.0.1"), commit);
});

test("the GitHub client reports an absent tag or file as null and rethrows other errors", () => {
  const client = createGitHubClient({ repository, gh: () => { throw notFound(); } });
  assert.equal(client.tagCommit("v2.0.1"), null);
  assert.equal(client.readFile("package.json", commit), null);
  const failing = createGitHubClient({
    repository,
    gh: () => {
      throw Object.assign(new Error("gh failed"), { stderr: "HTTP 502" });
    },
  });
  assert.throws(() => failing.tagCommit("v2.0.1"), /gh failed/);
  assert.throws(() => failing.readFile("package.json", commit), /gh failed/);
});

test("the GitHub client accepts only commits the default branch contains", () => {
  for (const [status, expected] of [
    ["ahead", true],
    ["identical", true],
    ["behind", false],
    ["diverged", false],
  ]) {
    const calls = [];
    const client = createGitHubClient({
      repository,
      gh: (args) => {
        calls.push(args);
        return JSON.stringify({ status });
      },
    });
    assert.equal(client.isCommitOnBranch(commit, "main"), expected, status);
    assert.equal(calls[0].at(-1), `repos/${repository}/compare/${commit}...main?per_page=1`);
  }
});

test("the GitHub client publishes without moving the latest marker backwards", () => {
  const calls = [];
  const client = createGitHubClient({ repository, gh: (args) => calls.push(args) && "" });
  client.publishRelease(7);
  assert.deepEqual(calls, [
    ["api", "--method", "PATCH", `repos/${repository}/releases/7`, "-F", "draft=false", "-f", "make_latest=legacy"],
  ]);
});

const fakeGh = ({ releases, onBranch = true }) => {
  const patches = [];
  const gh = (args) => {
    const path = args.at(-1);
    if (args.includes("PATCH")) {
      patches.push(args[3]);
      return "";
    }
    if (path === `repos/${repository}`) return JSON.stringify({ default_branch: "main" });
    if (path.startsWith(`repos/${repository}/releases?`)) return JSON.stringify([releases.slice(0, 1), releases.slice(1)]);
    if (path.startsWith(`repos/${repository}/git/ref/tags/`)) return JSON.stringify({ object: { type: "commit", sha: commit } });
    if (path.startsWith(`repos/${repository}/compare/`)) return JSON.stringify({ status: onBranch ? "ahead" : "diverged" });
    const file = /contents\/(.+)\?ref=/.exec(path)?.[1];
    const tag = releases.find((entry) => entry.draft)?.tag_name ?? "v0.0.0";
    const files = manifests(tag.slice(1));
    if (file in files) return JSON.stringify(files[file]);
    throw notFound();
  };
  return { gh, patches };
};

const runWith = ({ releases, readNpm, onBranch }) => {
  const directory = mkdtempSync(join(tmpdir(), "reconcile-"));
  const summary = join(directory, "summary.md");
  const logs = [];
  const { gh, patches } = fakeGh({ releases, onBranch });
  try {
    const exitCode = runReconcile({
      env: {
        REPOSITORY: repository,
        PACKAGE_FILES: packageFiles.join("\n"),
        MAX_PENDING_HOURS: "24",
        GITHUB_STEP_SUMMARY: summary,
      },
      now,
      gh,
      readNpm,
      log: (line) => logs.push(line),
    });
    return { exitCode, logs, patches, summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("a run publishes complete drafts and succeeds while others are pending", () => {
  const { exitCode, logs, patches, summary } = runWith({
    releases: [release("v2.0.1"), release("v2.0.0", { draft: false })],
    readNpm: () => ({ exists: true }),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(patches, [`repos/${repository}/releases/201`]);
  assert.match(logs.join("\n"), /::notice::v2\.0\.1 published/);
  assert.match(summary, /\| v2\.0\.1 \| published \|/);
});

test("a run fails when a draft is overdue", () => {
  const { exitCode, logs, patches } = runWith({
    releases: [release("v2.0.1", { created_at: hoursAgo(30) })],
    readNpm: visibleExcept("@stll/aho-corasick-wasm"),
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(patches, []);
  assert.match(logs.join("\n"), /::error::v2\.0\.1 overdue/);
});

test("a run fails without publishing when a tag is outside the default branch", () => {
  const { exitCode, patches } = runWith({
    releases: [release("v2.0.1")],
    readNpm: () => ({ exists: true }),
    onBranch: false,
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(patches, []);
});

test("a run requires package files", () => {
  assert.throws(() => runReconcile({ env: { REPOSITORY: repository, PACKAGE_FILES: " \n" } }), /package-files/);
});
