import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("./cla.yml", import.meta.url);

test("the Node 24 CLA client trusts the runner CA store", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const claStep = workflow.match(
    /uses: contributor-assistant\/github-action@[^\n]+\n(?<body>(?: {8,}.+\n)+)/u,
  );

  assert.ok(claStep?.groups?.["body"], "CLA Assistant step not found");
  assert.match(
    claStep.groups["body"],
    /^ {10}NODE_OPTIONS: "--use-system-ca"$/mu,
  );
});

test("CLA runs for one pull request never overlap", async () => {
  const caller = await readFile(new URL("./cla-check.yml", import.meta.url), "utf8");
  const job = caller.match(/^ {2}cla:\n(?<body>(?: {4,}.*\n|\n)+)/mu);

  assert.ok(job?.groups?.["body"], "cla job not found");
  assert.match(
    job.groups["body"],
    /^ {4}concurrency:\n {6}group: cla-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \}\}\n {6}cancel-in-progress: false$/mu,
  );
});
