import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("./ai-sync.yml", import.meta.url), "utf8");
const jobsSource = workflow.split(/^jobs:\s*$/mu)[1];

const jobNames = [...jobsSource.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gmu)].map(([, name]) => name);
const ciResultSource = jobsSource.split(/^  ci-result:\s*$/mu)[1];

test("ci-result always gates every other job without checking out the repository", () => {
  assert.ok(ciResultSource, "ci-result job is missing");
  assert.match(ciResultSource, /^    if: always\(\)$/mu);

  const needs = ciResultSource.match(/^    needs: \[([^\]]+)\]$/mu)?.[1]
    .split(",")
    .map((name) => name.trim());
  assert.deepEqual(needs?.sort(), jobNames.filter((name) => name !== "ci-result").sort());

  assert.doesNotMatch(ciResultSource, /actions\/checkout/u);
});

test("pull requests and merge groups run the aggregate gate", () => {
  assert.match(workflow, /^  pull_request:/mu);
  assert.match(workflow, /^  merge_group:/mu);
});
