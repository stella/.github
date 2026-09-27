import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  baseBranch,
  context,
  globToRegExp,
  matchesPaths,
  planScopes,
  resolveSuiteDepth,
  resolveTrust,
  scope,
  validatePolicy,
  workflowFileOf,
} from "./plan.mjs";

const policy = validatePolicy({
  runAll: [".github/workflows/**", "package.json"],
  fullDepth: "scoped",
  areas: {
    code: { paths: ["**", "!**/*.md", "api-reports/**"] },
    kernel: { paths: ["crates/**", "Cargo.{toml,lock}"] },
    e2e: { paths: ["apps/web/**", "!apps/web/e2e/marketing/**"] },
    web_build: { paths: ["apps/web/src/**"], with: ["e2e"] },
    release: { paths: ["VERSION"], runAll: "exclude" },
  },
});

const scoped = (files, overrides = {}) =>
  planScopes({ policy, eventName: "pull_request", suiteDepth: "fast", files, ...overrides });

test("globs follow GitHub's paths syntax", () => {
  assert.ok(globToRegExp("crates/**").test("crates/a/b/lib.rs"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("docs/a/b.md"));
  assert.ok(!globToRegExp("docs/*.md").test("docs/a/b.md"));
  assert.ok(globToRegExp("Cargo.{toml,lock}").test("Cargo.lock"));
  assert.ok(!globToRegExp("Cargo.{toml,lock}").test("Cargo.json"));
  assert.ok(globToRegExp("file?.ts").test("file1.ts"));
  assert.ok(!globToRegExp("file?.ts").test("file/.ts"));
  assert.ok(!globToRegExp("a.b").test("axb"));
  assert.ok(globToRegExp("packages/pkg[0-9]/**").test("packages/pkg7/src/index.ts"));
  assert.ok(!globToRegExp("packages/pkg[0-9]/**").test("packages/pkga/src/index.ts"));
  assert.ok(globToRegExp("packages/pkg[CB]/**").test("packages/pkgC/src/index.ts"));
  assert.ok(!globToRegExp("packages/pkg[CB]/**").test("packages/pkgA/src/index.ts"));
  assert.ok(globToRegExp("packages/pkg[0-9a-z]/**").test("packages/pkgq/src/index.ts"));
  assert.ok(globToRegExp(String.raw`packages/pkg\[0-9\]/**`).test("packages/pkg[0-9]/src/index.ts"));
  assert.throws(() => globToRegExp("packages/pkg[!0-9]/**"), /Invalid character class/);
  assert.throws(() => globToRegExp("packages/pkg[z-a]/**"), /Reversed range/);
  assert.throws(() => globToRegExp("packages/pkg[0-9/**"), /Unclosed/);
});

test("the last matching pattern decides, as in GitHub's paths filter", () => {
  const patterns = ["**", "!**/*.md", "api-reports/**"];
  assert.equal(matchesPaths(patterns, "src/index.ts"), true);
  assert.equal(matchesPaths(patterns, "docs/guide.md"), false);
  assert.equal(matchesPaths(patterns, "api-reports/core.api.md"), true);
});

test("a pull request selects only the areas its paths match", () => {
  assert.deepEqual(scoped(["docs/guide.md"]), {
    runAll: false,
    areas: { code: false, kernel: false, e2e: false, web_build: false, release: false },
  });
  assert.deepEqual(scoped(["crates/kernel/src/lib.rs"]).areas, {
    code: true,
    kernel: true,
    e2e: false,
    web_build: false,
    release: false,
  });
  assert.equal(scoped(["apps/web/e2e/marketing/landing.spec.ts"]).areas.e2e, false);
  assert.equal(scoped(["VERSION"]).areas.release, true);
});

test("character-class paths select their area", () => {
  const withRange = validatePolicy({
    ...policy,
    areas: { packages: { paths: ["packages/pkg[0-9]/**"] } },
  });
  const plan = (file) => planScopes({ policy: withRange, eventName: "pull_request", suiteDepth: "fast", files: [file] });
  assert.equal(plan("packages/pkg7/src/index.ts").areas.packages, true);
  assert.equal(plan("packages/pkga/src/index.ts").areas.packages, false);
});

test("an area listed in `with` pulls the listing area in", () => {
  assert.equal(scoped(["apps/web/e2e/core.spec.ts"]).areas.web_build, true);
});

test("a run-all path selects every area but those that exclude themselves", () => {
  assert.deepEqual(scoped([".github/workflows/ci.yml"]), {
    runAll: true,
    areas: { code: true, kernel: true, e2e: true, web_build: true, release: false },
  });
});

test("events without a pull request diff select every area", () => {
  for (const eventName of ["push", "workflow_dispatch", "schedule"]) {
    const plan = planScopes({ policy, eventName, suiteDepth: "full", files: [] });
    assert.equal(plan.runAll, true, eventName);
    assert.equal(plan.areas.kernel, true, eventName);
  }
});

test("full depth keeps path scopes unless the policy selects all", () => {
  assert.equal(scoped(["docs/a.md"], { eventName: "merge_group", suiteDepth: "full" }).runAll, false);
  const all = validatePolicy({ ...policy, fullDepth: "all" });
  for (const eventName of ["merge_group", "pull_request"]) {
    const plan = planScopes({ policy: all, eventName, suiteDepth: "full", files: ["docs/a.md"] });
    assert.equal(plan.runAll, true, eventName);
    assert.equal(plan.areas.kernel, true, eventName);
  }
  assert.equal(
    planScopes({ policy: all, eventName: "pull_request", suiteDepth: "fast", files: ["docs/a.md"] })
      .runAll,
    false,
  );
});

test("only a labelled pull request plans full depth among pull requests", () => {
  assert.equal(resolveSuiteDepth({ eventName: "pull_request", labels: [], fullLabel: "ci:full" }), "fast");
  assert.equal(
    resolveSuiteDepth({ eventName: "pull_request", labels: ["bug", "ci:full"], fullLabel: "ci:full" }),
    "full",
  );
  for (const eventName of ["merge_group", "workflow_dispatch", "push"]) {
    assert.equal(resolveSuiteDepth({ eventName, labels: [], fullLabel: "ci:full" }), "full");
  }
});

test("the policy is validated strictly", () => {
  const cases = [
    [{ ...policy, extra: [] }, /Unknown policy key/],
    [{ ...policy, fullDepth: "some" }, /'fullDepth' must be one of/],
    [{ ...policy, runAll: "x" }, /'runAll' must be a list/],
    [{ ...policy, areas: {} }, /at least one area/],
    [{ ...policy, areas: { "Bad-Name": { paths: ["a"] } } }, /must match/],
    [{ ...policy, areas: { a: { paths: [] , typo: 1 } } }, /unknown key 'typo'/],
    [{ ...policy, areas: { a: { paths: [""] } } }, /needs 'paths'/],
    [{ ...policy, areas: { a: { paths: ["!docs/**"] } } }, /at least one positive pattern/],
    [{ ...policy, areas: { a: { paths: [] } } }, /at least one positive pattern/],
    [{ ...policy, areas: { a: { paths: ["x"], with: ["b"] } } }, /unknown area 'b'/],
    [{ ...policy, areas: { a: { paths: ["x"], with: ["a"] } } }, /cannot list itself/],
    [{ ...policy, areas: { a: { paths: ["x"], runAll: "no" } } }, /'runAll' must be one of/],
    [{ ...policy, areas: { a: { paths: ["x{y"] } } }, /Unclosed/],
  ];
  for (const [candidate, message] of cases) {
    assert.throws(() => validatePolicy(candidate), message);
  }
});

test("the base branch comes from the pull request, then the merge group, then the default", () => {
  assert.equal(baseBranch({ baseRef: "main", mergeGroupBaseRef: "", defaultBranch: "x" }), "main");
  assert.equal(
    baseBranch({ baseRef: "", mergeGroupBaseRef: "refs/heads/release", defaultBranch: "main" }),
    "release",
  );
  assert.equal(baseBranch({ baseRef: "", mergeGroupBaseRef: "", defaultBranch: "main" }), "main");
});

test("the workflow file is read from the workflow ref", () => {
  assert.equal(workflowFileOf("stella/folio/.github/workflows/ci.yml@refs/heads/main"), "ci.yml");
  assert.throws(() => workflowFileOf("nonsense"), /Cannot read the workflow file/);
});

const fakeApi = (responses) => async (path) => {
  const key = Object.keys(responses).find((prefix) => path.startsWith(prefix));
  assert.ok(key, `unexpected API call ${path}`);
  return responses[key];
};

test("a merge group is trusted for a same-repository pull request", async () => {
  const trust = await resolveTrust({
    eventName: "merge_group",
    mergeGroupHeadRef: "refs/heads/gh-readonly-queue/main/pr-12-0123abcd",
    repository: "stella/example",
    workflowFile: "ci.yml",
    api: fakeApi({ "repos/stella/example/pulls/12": { head: { repo: { full_name: "stella/example" }, sha: "abc" } } }),
  });
  assert.deepEqual(trust, { trusted: true });
});

test("a fork merge group is trusted only after its head passed a pull_request run", async () => {
  const pull = { head: { repo: { full_name: "someone/example" }, sha: "abc" } };
  const options = {
    eventName: "merge_group",
    mergeGroupHeadRef: "refs/heads/gh-readonly-queue/main/pr-12-0123abcd",
    repository: "stella/example",
    workflowFile: "ci.yml",
  };
  const passed = await resolveTrust({
    ...options,
    api: fakeApi({
      "repos/stella/example/pulls/12": pull,
      "repos/stella/example/actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=abc": {
        total_count: 1,
      },
    }),
  });
  assert.deepEqual(passed, { trusted: true });
  const notPassed = await resolveTrust({
    ...options,
    api: fakeApi({
      "repos/stella/example/pulls/12": pull,
      "repos/stella/example/actions/workflows/ci.yml/runs": { total_count: 0 },
    }),
  });
  assert.equal(notPassed.trusted, false);
  assert.match(notPassed.reason, /no successful pull_request run/);
});

test("a merge group whose head ref names no pull request is untrusted", async () => {
  const trust = await resolveTrust({
    eventName: "merge_group",
    mergeGroupHeadRef: "refs/heads/other",
    repository: "stella/example",
    workflowFile: "ci.yml",
    api: fakeApi({}),
  });
  assert.equal(trust.trusted, false);
});

test("the context stage reads labels live and never trusts by default on merge groups", async () => {
  const environment = {
    EVENT_NAME: "pull_request",
    FULL_LABEL: "ci:full",
    PR_NUMBER: "7",
    REPOSITORY: "stella/example",
  };
  assert.deepEqual(
    await context(environment, fakeApi({ "repos/stella/example/issues/7/labels": [{ name: "ci:full" }] })),
    { "suite-depth": "full", trusted: "true" },
  );
  assert.deepEqual(
    await context(environment, fakeApi({ "repos/stella/example/issues/7/labels": [{ name: "bug" }] })),
    { "suite-depth": "fast", trusted: "true" },
  );
  await assert.rejects(
    context(
      { ...environment, EVENT_NAME: "merge_group", MERGE_GROUP_HEAD_REF: "x", WORKFLOW_REF: "o/r/.github/workflows/ci.yml@refs/heads/main" },
      fakeApi({}),
    ),
    /does not name a pull request/,
  );
});

test("the context stage rejects a fork merge group without a successful pull_request run", async () => {
  await assert.rejects(
    context(
      {
        EVENT_NAME: "merge_group",
        FULL_LABEL: "ci:full",
        MERGE_GROUP_HEAD_REF: "refs/heads/gh-readonly-queue/main/pr-12-0123abcd",
        REPOSITORY: "stella/example",
        WORKFLOW_REF: "stella/example/.github/workflows/ci.yml@refs/heads/main",
      },
      fakeApi({
        "repos/stella/example/pulls/12": { head: { repo: { full_name: "someone/example" }, sha: "abc" } },
        "repos/stella/example/actions/workflows/ci.yml/runs": { total_count: 0 },
      }),
    ),
    /no successful pull_request run/,
  );
});

test("an untrusted merge group exits the context step unsuccessfully", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./plan.mjs", import.meta.url)), "context"], {
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: "merge_group",
      FULL_LABEL: "ci:full",
      MERGE_GROUP_HEAD_REF: "refs/heads/other",
      REPOSITORY: "stella/example",
      WORKFLOW_REF: "stella/example/.github/workflows/ci.yml@refs/heads/main",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::Merge group head ref does not name a pull request/);
});

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
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

test("the scope stage diffs against the merge base, both sides of a rename included", () => {
  const origin = mkdtempSync(join(tmpdir(), "ci-plan-origin-"));
  roots.push(origin);
  git(origin, "init", "-q", "-b", "main");
  write(origin, "crates/kernel/src/lib.rs", "fn main() {}\n");
  write(origin, "docs/guide.md", "# Guide\n");
  write(origin, ".github/ci-plan.json", JSON.stringify(policy));
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "base");

  const clone = mkdtempSync(join(tmpdir(), "ci-plan-clone-"));
  roots.push(clone);
  git(clone, "clone", "-q", origin, ".");
  git(clone, "switch", "-q", "-c", "topic");
  git(clone, "mv", "crates/kernel/src/lib.rs", "docs/lib.md");
  git(clone, "commit", "-q", "-m", "move");
  // main moves on after the branch point; its change is not the pull request's.
  write(origin, "package.json", "{}\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "later");
  git(clone, "fetch", "-q", "origin");

  const summary = join(clone, "summary.md");
  const cwd = process.cwd();
  process.chdir(clone);
  try {
    const outputs = scope({
      BASE_REF: "main",
      DEFAULT_BRANCH: "main",
      EVENT_NAME: "pull_request",
      GITHUB_STEP_SUMMARY: summary,
      POLICY_FILE: ".github/ci-plan.json",
      SUITE_DEPTH: "fast",
      TRUSTED: "true",
    });
    assert.equal(outputs["run-all"], "false");
    assert.deepEqual(JSON.parse(outputs.areas), {
      code: true,
      kernel: true,
      e2e: false,
      web_build: false,
      release: false,
    });
    assert.match(readFileSync(summary, "utf8"), /\| kernel \| true \|/);
  } finally {
    process.chdir(cwd);
  }
});

test("an untrusted run selects nothing and reads no policy", () => {
  assert.deepEqual(scope({ TRUSTED: "false" }), { "run-all": "false", areas: "{}" });
});
