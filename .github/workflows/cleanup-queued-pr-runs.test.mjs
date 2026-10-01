import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("./cleanup-queued-pr-runs.yml", import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const OPEN_HEAD = "a".repeat(40);
const STALE_HEAD = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const HOUR = 60 * 60 * 1000;

const loadWorkflow = () => readFile(workflowUrl, "utf8");

const loadScript = async () => {
  const workflow = await loadWorkflow();
  const block = workflow.match(/^ {10}script: \|\n(?<body>(?:(?: {12}.*)?\n)+)/mu);
  assert.ok(block?.groups?.["body"], "github-script body not found");
  return block.groups["body"].replace(/^ {12}/gmu, "");
};

const queuedRun = (id, event, headSha, ageHours) => ({
  id,
  event,
  status: "queued",
  head_sha: headSha,
  created_at: new Date(Date.now() - ageHours * HOUR).toISOString(),
});

const runCleanup = async (runs) => {
  const cancelled = [];
  const failures = [];
  const byId = new Map(runs.map((run) => [run.id, run]));
  const github = {
    rest: {
      pulls: { list: "pulls.list" },
      actions: {
        listWorkflowRunsForRepo: "actions.listWorkflowRunsForRepo",
        getWorkflowRun: async ({ run_id }) => ({ data: byId.get(run_id) }),
        cancelWorkflowRun: async ({ run_id }) => {
          cancelled.push(run_id);
        },
      },
    },
    paginate: async (endpoint) => {
      if (endpoint === "pulls.list") return [{ head: { sha: OPEN_HEAD } }];
      if (endpoint === "actions.listWorkflowRunsForRepo") return runs;
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    request: async () => {
      throw new Error("force-cancel not expected");
    },
  };
  const core = {
    info: () => {},
    warning: () => {},
    error: (message) => failures.push(message),
    setFailed: (message) => failures.push(message),
  };
  const context = { repo: { owner: "stella", repo: "example" } };
  const script = await loadScript();
  await new AsyncFunction("github", "context", "core", script)(github, context, core);
  assert.deepEqual(failures, []);
  return cancelled;
};

test("cancels pull_request runs whose head is no longer an open PR head", async () => {
  const cancelled = await runCleanup([
    queuedRun(1, "pull_request", OPEN_HEAD, 0),
    queuedRun(2, "pull_request", STALE_HEAD, 0),
  ]);
  assert.deepEqual(cancelled, [2]);
});

test("never treats a fresh pull_request_target run as superseded", async () => {
  // pull_request_target runs report the base commit as head_sha.
  const cancelled = await runCleanup([
    queuedRun(1, "pull_request_target", BASE_SHA, 0),
  ]);
  assert.deepEqual(cancelled, []);
});

test("cancels any PR run queued longer than six hours", async () => {
  const cancelled = await runCleanup([
    queuedRun(1, "pull_request_target", BASE_SHA, 7),
    queuedRun(2, "pull_request", OPEN_HEAD, 7),
    queuedRun(3, "push", STALE_HEAD, 7),
  ]);
  assert.deepEqual(cancelled, [1, 2]);
});

test("grants read access for every REST scope the script calls", async () => {
  const workflow = await loadWorkflow();
  const script = await loadScript();
  const scopePermission = { actions: "actions", pulls: "pull-requests" };
  const scopes = new Set(
    [...script.matchAll(/github\.rest\.(?<scope>\w+)\./gu)].map((m) => m.groups["scope"]),
  );
  for (const scope of scopes) {
    const permission = scopePermission[scope];
    assert.ok(permission, `no permission mapping for github.rest.${scope}`);
    assert.match(workflow, new RegExp(`^ {2}${permission}: (?:read|write)$`, "mu"));
  }
});
