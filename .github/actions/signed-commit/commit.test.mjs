import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "commit.sh");
const REPO = "stella/example";
const BRANCH = "chore/refresh";
const BUILD_BRANCH = `${BRANCH}-next`;

// Records every invocation and answers the handful of calls commit.sh makes.
// Branch refs are kept in a file so create, read, and delete stay consistent
// within one run; GraphQL request bodies are kept for payload assertions.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\037' "$@" >> "$FAKE_GH_LOG"
printf '\\n' >> "$FAKE_GH_LOG"
refs="$FAKE_GH_DIR/refs"
case "$1 $2" in
  "api graphql")
    n="$(find "$FAKE_GH_DIR" -name 'request-*' | wc -l | tr -d ' ')"
    n=$((n + 1))
    for ((i = 1; i <= $#; i++)); do
      if [ "\${!i}" = "--input" ]; then
        j=$((i + 1))
        cp "\${!j}" "$FAKE_GH_DIR/request-$n.json"
      fi
    done
    echo "oid-$n"
    ;;
  "api -X")
    case "$3" in
      POST)
        for arg in "$@"; do
          case "$arg" in ref=refs/heads/*) echo "\${arg#ref=refs/heads/}" >> "$refs" ;; esac
        done
        ;;
      DELETE)
        name="\${4#repos/*/git/refs/heads/}"
        grep -vx "$name" "$refs" > "$refs.tmp" || true
        mv "$refs.tmp" "$refs"
        ;;
      PATCH)
        name="\${4#repos/*/git/refs/heads/}"
        grep -qx "$name" "$refs" || exit 22
        ;;
    esac
    ;;
  "api repos/"*)
    grep -qx "\${2#repos/*/git/ref/heads/}" "$refs"
    ;;
  "pr list")
    [ -z "\${FAKE_GH_PR:-}" ] || echo "$FAKE_GH_PR https://example.test/pr/$FAKE_GH_PR"
    ;;
  "pr create") echo "https://example.test/pr/42" ;;
  "pr edit" | "pr close") ;;
  *)
    echo "fake gh: unexpected call: $*" >&2
    exit 64
    ;;
esac
`;

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

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "signed-commit-"));
  roots.push(root);
  const bin = join(root, ".fake-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const state = join(root, ".fake-state");
  mkdirSync(state);

  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, "managed/a.txt", "a v1\n");
  write(repo, "managed/old.txt", "old\n");
  write(repo, "outside.txt", "outside v1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, bin, state, headOid: git(repo, "rev-parse", "HEAD") };
};

const run = ({ repo, bin, state }, env, { branches = [] } = {}) => {
  const log = join(state, "gh.log");
  const outputs = join(state, "outputs");
  const summary = join(state, "summary.md");
  writeFileSync(log, "");
  writeFileSync(outputs, "");
  writeFileSync(summary, "");
  writeFileSync(join(state, "refs"), branches.map((name) => `${name}\n`).join(""));
  const result = spawnSync("bash", ["-eo", "pipefail", script], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      ...isolatedGitEnv,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "fixture-token",
      GITHUB_REPOSITORY: REPO,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      FAKE_GH_LOG: log,
      FAKE_GH_DIR: state,
      MODE: "refresh-pr",
      BRANCH,
      BASE: "main",
      PATHS: "managed/**",
      COMMIT_MESSAGE: "chore: refresh managed files\n\nBody line one.\nBody line two.",
      PR_TITLE: "chore: refresh managed files",
      PR_BODY: "Automated refresh.",
      ...env,
    },
  });
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\x1f").slice(0, -1));
  const requests = readdirSync(state)
    .filter((name) => name.startsWith("request-"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(state, name), "utf8")));
  const outputMap = Object.fromEntries(
    readFileSync(outputs, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const remainingBranches = readFileSync(join(state, "refs"), "utf8").split("\n").filter(Boolean);
  return { result, calls, requests, outputs: outputMap, remainingBranches };
};

const commitInput = (request) => request.variables.input;
const calledWith = (calls, ...prefix) =>
  calls.filter((args) => prefix.every((part, index) => args[index] === part));
const refWrites = (calls) => calledWith(calls, "api", "-X").map((args) => args.slice(2));

const createRef = (name, sha) => ["POST", `repos/${REPO}/git/refs`, "-f", `ref=refs/heads/${name}`, "-f", `sha=${sha}`, "--silent"];
const forceRef = (name, sha) => ["PATCH", `repos/${REPO}/git/refs/heads/${name}`, "-f", `sha=${sha}`, "-F", "force=true", "--silent"];
const deleteRef = (name) => ["DELETE", `repos/${REPO}/git/refs/heads/${name}`, "--silent"];

test("refresh-pr builds the proposal on a scratch branch, moves the branch onto it, and opens a pull request", () => {
  const fx = fixture();
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  write(fx.repo, "managed/a.txt", "a v2\n");
  write(fx.repo, "managed/bin.dat", binary);
  write(fx.repo, "managed/sub/nested.txt", "nested\n");
  rmSync(join(fx.repo, "managed/old.txt"));
  write(fx.repo, "outside.txt", "outside v2\n");

  const { result, calls, requests, outputs, remainingBranches } = run(fx, {});
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(refWrites(calls), [
    createRef(BUILD_BRANCH, fx.headOid),
    createRef(BRANCH, "oid-1"),
    deleteRef(BUILD_BRANCH),
  ]);
  assert.deepEqual(remainingBranches, [BRANCH]);

  assert.equal(requests.length, 1);
  const input = commitInput(requests[0]);
  assert.deepEqual(input.branch, { repositoryNameWithOwner: REPO, branchName: BUILD_BRANCH });
  assert.equal(input.expectedHeadOid, fx.headOid);
  assert.deepEqual(input.message, {
    headline: "chore: refresh managed files",
    body: "Body line one.\nBody line two.",
  });
  assert.deepEqual(
    input.fileChanges.additions.map((entry) => entry.path).sort(),
    ["managed/a.txt", "managed/bin.dat", "managed/sub/nested.txt"],
  );
  const contents = Object.fromEntries(input.fileChanges.additions.map((entry) => [entry.path, entry.contents]));
  assert.equal(contents["managed/bin.dat"], binary.toString("base64"));
  assert.equal(contents["managed/a.txt"], Buffer.from("a v2\n").toString("base64"));
  assert.deepEqual(input.fileChanges.deletions, [{ path: "managed/old.txt" }]);

  const create = calledWith(calls, "pr", "create");
  assert.equal(create.length, 1);
  assert.ok(create[0].includes("--base") && create[0].includes("main"));
  assert.ok(create[0].includes("--head") && create[0].includes(BRANCH));
  assert.equal(outputs.operation, "created");
  assert.equal(outputs["commit-sha"], "oid-1");
  assert.equal(outputs["pull-request-number"], "42");
  assert.equal(outputs["pull-request-url"], "https://example.test/pr/42");
});

test("refresh-pr force-moves an existing branch and retitles the open pull request", () => {
  const fx = fixture();
  write(fx.repo, "managed/a.txt", "a v2\n");

  const { result, calls, requests, outputs, remainingBranches } = run(fx, { FAKE_GH_PR: "7" }, { branches: [BRANCH] });
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(refWrites(calls), [
    createRef(BUILD_BRANCH, fx.headOid),
    forceRef(BRANCH, "oid-1"),
    deleteRef(BUILD_BRANCH),
  ]);
  assert.deepEqual(remainingBranches, [BRANCH]);
  assert.equal(requests.length, 1);
  assert.equal(calledWith(calls, "pr", "create").length, 0);
  const edit = calledWith(calls, "pr", "edit");
  assert.equal(edit.length, 1);
  assert.ok(edit[0].includes("7"));
  assert.equal(outputs.operation, "updated");
  assert.equal(outputs["pull-request-number"], "7");
});

test("refresh-pr reuses a scratch branch left by an interrupted run", () => {
  const fx = fixture();
  write(fx.repo, "managed/a.txt", "a v2\n");

  const { result, calls } = run(fx, {}, { branches: [BRANCH, BUILD_BRANCH] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(refWrites(calls), [
    forceRef(BUILD_BRANCH, fx.headOid),
    forceRef(BRANCH, "oid-1"),
    deleteRef(BUILD_BRANCH),
  ]);
});

test("refresh-pr without changes closes the stale pull request and deletes both branches", () => {
  const fx = fixture();
  write(fx.repo, "outside.txt", "outside v2\n");

  const { result, calls, requests, outputs, remainingBranches } = run(
    fx,
    { FAKE_GH_PR: "7" },
    { branches: [BRANCH, BUILD_BRANCH] },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0);
  assert.deepEqual(calledWith(calls, "pr", "close"), [["pr", "close", "--repo", REPO, "7"]]);
  assert.deepEqual(refWrites(calls), [deleteRef(BRANCH), deleteRef(BUILD_BRANCH)]);
  assert.deepEqual(remainingBranches, []);
  assert.equal(outputs.operation, "closed");
  assert.equal(outputs["commit-sha"], "");
});

test("refresh-pr without changes and without a proposal touches nothing", () => {
  const fx = fixture();
  const { result, calls, outputs } = run(fx, {});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(refWrites(calls).length, 0);
  assert.equal(calledWith(calls, "pr", "close").length, 0);
  assert.equal(outputs.operation, "none");
});

test("append commits straight onto the branch and leaves refs and pull requests alone", () => {
  const fx = fixture();
  write(fx.repo, "managed/a.txt", "a v2\n");

  const { result, calls, requests, outputs } = run(fx, { MODE: "append", BASE: "", PR_TITLE: "" }, { branches: [BRANCH] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(refWrites(calls).length, 0);
  assert.equal(calledWith(calls, "pr").length, 0);
  assert.equal(requests.length, 1);
  const input = commitInput(requests[0]);
  assert.equal(input.branch.branchName, BRANCH);
  assert.equal(input.expectedHeadOid, fx.headOid);
  assert.equal(outputs.operation, "committed");
  assert.equal(outputs["commit-sha"], "oid-1");
});

test("a change set over max-commit-bytes is split into chained commits", () => {
  const fx = fixture();
  write(fx.repo, "managed/f1.txt", "0123456789");
  write(fx.repo, "managed/f2.txt", "0123456789");
  write(fx.repo, "managed/f3.txt", "0123456789");
  rmSync(join(fx.repo, "managed/old.txt"));

  const { result, calls, requests, outputs } = run(fx, { MAX_COMMIT_BYTES: "15" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 3);
  const inputs = requests.map(commitInput);
  assert.deepEqual(
    inputs.map((input) => input.expectedHeadOid),
    [fx.headOid, "oid-1", "oid-2"],
  );
  assert.deepEqual(
    inputs.map((input) => input.fileChanges.additions.map((entry) => entry.path)),
    [["managed/f1.txt"], ["managed/f2.txt"], ["managed/f3.txt"]],
  );
  assert.deepEqual(
    inputs.map((input) => input.fileChanges.deletions),
    [[], [], [{ path: "managed/old.txt" }]],
  );
  assert.deepEqual(refWrites(calls)[1], createRef(BRANCH, "oid-3"));
  assert.equal(outputs["commit-sha"], "oid-3");
});

test("a symlink under the managed paths fails the step before any API call", () => {
  const fx = fixture();
  symlinkSync("a.txt", join(fx.repo, "managed/link.txt"));

  const { result, calls } = run(fx, {});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink or submodule/);
  assert.equal(calls.length, 0);
});

test("a branch name that could read as an option or traversal is refused", () => {
  const fx = fixture();
  write(fx.repo, "managed/a.txt", "a v2\n");
  for (const branch of ["-x", "a..b", "/abs", "has space", "trail/"]) {
    const { result, calls } = run(fx, { BRANCH: branch });
    assert.notEqual(result.status, 0, branch);
    assert.match(result.stderr, /Invalid branch/);
    assert.equal(calls.length, 0);
  }
});

test("the action's own untracked checkout inside the workspace is never committed", () => {
  const fx = fixture();
  write(fx.repo, "managed/a.txt", "a v2\n");
  write(fx.repo, ".signed-commit/.github/actions/signed-commit/commit.sh", "#!/bin/bash\n");

  const { result, requests } = run(fx, {
    PATHS: ".",
    ACTION_PATH: join(fx.repo, ".signed-commit/.github/actions/signed-commit"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    commitInput(requests[0]).fileChanges.additions.map((entry) => entry.path),
    ["managed/a.txt"],
  );
});

test("a tracked caller-local action directory is still committed", () => {
  const fx = fixture();
  write(fx.repo, ".github/actions/signed-commit/commit.sh", "#!/bin/bash\n");
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-q", "-m", "add local action");
  const headOid = git(fx.repo, "rev-parse", "HEAD");
  write(fx.repo, ".github/actions/signed-commit/commit.sh", "#!/bin/bash\necho changed\n");

  const { result, requests } = run(fx, {
    PATHS: ".",
    ACTION_PATH: join(fx.repo, ".github/actions/signed-commit"),
  });
  assert.equal(result.status, 0, result.stderr);
  const input = commitInput(requests[0]);
  assert.equal(input.expectedHeadOid, headOid);
  assert.deepEqual(
    input.fileChanges.additions.map((entry) => entry.path),
    [".github/actions/signed-commit/commit.sh"],
  );
});
