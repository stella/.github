import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const sync = await readFile(new URL("provenance-sync.yml", import.meta.url), "utf8");
const commit = await readFile(new URL("provenance-commit.yml", import.meta.url), "utf8");

test("pull request code runs without secrets or write access", () => {
  assert.doesNotMatch(sync, /secrets[.:]/);
  assert.doesNotMatch(sync, /contents: write/);
  assert.doesNotMatch(sync, /github\.token/);
  assert.match(sync, /github\.event_name == 'pull_request'\n/);
  assert.match(sync, /persist-credentials: false/);
  assert.match(sync, /no-cache: true/);
  assert.match(sync, /name: provenance\n/);
});

test("the committing workflow never runs pull request code", () => {
  assert.doesNotMatch(commit, /install-command|provenance generate|setup-bun|setup-node|\bbun |\bnpm /);
  assert.match(commit, /persist-credentials: false/);
  assert.match(commit, /github\.event\.workflow_run\.event == 'pull_request'/);
  assert.match(commit, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(commit, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

test("the pull request is resolved through the API, not from the run payload's pull_requests", () => {
  assert.doesNotMatch(commit, /workflow_run\.pull_requests/);
  assert.match(commit, /GET \/repos\/\{owner\}\/\{repo\}\/pulls"/);
  assert.match(commit, /pull\.head\?\.sha === run\.head_sha/);
  assert.match(commit, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
});

test("the provenance path comes from the trusted caller input, not the run", () => {
  assert.match(commit, /PROVENANCE_ROOT: \$\{\{ inputs\.root \}\}/);
  assert.match(commit, /paths: \$\{\{ steps\.stage\.outputs\.provenance-path \}\}\/\*\*/);
});

test("the refresh commit is owned by the App, never GITHUB_TOKEN", () => {
  assert.match(commit, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  // GITHUB_TOKEN only reads the triggering run's artifact.
  assert.deepEqual(commit.match(/github\.token/g), ["github.token"]);
  assert.match(commit, /github-token: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(commit, /git push/);
  assert.match(commit, /client-id: \$\{\{ secrets\.app_id \}\}/);
  assert.doesNotMatch(commit, /^\s+app-id:/m);
});

test("the staged archive admits only plain files under relative paths", () => {
  assert.match(commit, /grep -qv '\^\[-d\]'/);
  assert.match(commit, /--no-same-owner --no-same-permissions/);
});
