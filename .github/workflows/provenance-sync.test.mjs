import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(
  new URL("provenance-sync.yml", import.meta.url),
  "utf8",
);

const jobSection = (name, next) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = next === undefined ? workflow.length : workflow.indexOf(`\n  ${next}:\n`, start);
  assert.notEqual(end, -1, `missing ${next} job`);
  return workflow.slice(start, end);
};

const generate = jobSection("generate", "commit");
const commit = jobSection("commit");

test("pull request code runs without secrets or write access", () => {
  assert.doesNotMatch(generate, /secrets\./);
  assert.doesNotMatch(generate, /contents: write/);
  assert.match(generate, /persist-credentials: false/);
  assert.match(generate, /no-cache: true/);
});

test("the committing job never runs pull request code", () => {
  assert.doesNotMatch(commit, /install-command/);
  assert.doesNotMatch(commit, /provenance generate/);
  assert.match(commit, /persist-credentials: false/);
});

test("the refresh commit is owned by the App, never GITHUB_TOKEN", () => {
  assert.match(commit, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow, /github\.token/);
  assert.doesNotMatch(workflow, /git push/);
  assert.match(commit, /client-id: \$\{\{ secrets\.app_id \}\}/);
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
});

test("the staged archive admits only plain files under relative paths", () => {
  assert.match(commit, /grep -qv '\^\[-d\]'/);
  assert.match(commit, /--no-same-owner --no-same-permissions/);
});
