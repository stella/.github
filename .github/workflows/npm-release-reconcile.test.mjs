import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("./npm-release-reconcile.yml", import.meta.url),
  "utf8",
);

test("the reconcile workflow is reusable only", () => {
  assert.match(workflow, /^on:\n {2}workflow_call:\n/m);
  assert.doesNotMatch(workflow, /^\s+(?:schedule|push|pull_request|workflow_dispatch):/m);
});

test("the reconcile job token can only read contents", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  const permissions = [...workflow.matchAll(/^ {4}permissions:\n((?: {6}.+\n)+)/gm)].map(
    ([, body]) => body,
  );
  assert.deepEqual(permissions, ["      contents: read # Check out the pinned release tooling.\n"]);
});

test("the release App token is scoped to repository contents", () => {
  assert.match(workflow, /permission-contents: write\n/);
  assert.doesNotMatch(workflow, /permission-(?!contents)[a-z-]+:/);
  assert.match(workflow, /RELEASE_APP_ID:\n\s+description: [^\n]+\n\s+required: true/);
  assert.match(workflow, /RELEASE_APP_PRIVATE_KEY:\n\s+description: [^\n]+\n\s+required: true/);
});

test("every action is pinned by commit and the helper by workflow commit", () => {
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map(([, use]) => use);
  assert.ok(uses.length > 0);
  for (const use of uses) {
    assert.match(use, /@[0-9a-f]{40}$/, use);
  }
  assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
});
