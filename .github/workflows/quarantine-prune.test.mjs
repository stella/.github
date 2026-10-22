import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("./quarantine-prune.yml", import.meta.url),
  "utf8",
);

const job = (name) => {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const remainder = workflow.slice(start + `  ${name}:\n`.length);
  const nextJob = remainder.search(/^  [a-z][a-z-]+:/m);
  const end =
    nextJob === -1 ? undefined : start + `  ${name}:\n`.length + nextJob;
  return workflow.slice(start, end);
};

const steps = (jobBlock) => {
  const starts = [...jobBlock.matchAll(/^      - /gm)].map(({ index }) => index);
  return starts.map((start, index) => jobBlock.slice(start, starts[index + 1]));
};

test("the repository-scoped app token is exposed only to the signed-commit step", () => {
  const tokenAction = "uses: actions/create-github-app-token@";
  const tokenReference = "${{ steps.app-token.outputs.token }}";
  const proposeSteps = steps(job("propose"));
  const tokenIndex = proposeSteps.findIndex((step) => step.includes(tokenAction));

  assert.equal(
    workflow.split(tokenAction).length - 1,
    1,
    "the token action must occur exactly once in the workflow",
  );
  assert.notEqual(tokenIndex, -1, "the token step must be in the propose job");

  const tokenStep = proposeSteps[tokenIndex];
  assert.match(tokenStep, /\n {8}id: app-token$/m);
  assert.match(tokenStep, /\n {10}owner: \$\{\{ github\.repository_owner \}\}$/m);
  assert.match(
    tokenStep,
    /\n {10}repositories: \$\{\{ github\.event\.repository\.name \}\}$/m,
  );
  assert.match(tokenStep, /\n {10}permission-contents: write$/m);
  assert.match(tokenStep, /\n {10}permission-pull-requests: write$/m);

  const signedCommitStep = proposeSteps[tokenIndex + 1];
  assert.ok(signedCommitStep, "the token step must have a following step");
  assert.match(
    signedCommitStep,
    /uses: \.\/\.quarantine-policy\/\.github\/actions\/signed-commit/,
  );
  assert.match(signedCommitStep, /\n {10}token: \$\{\{ steps\.app-token\.outputs\.token \}\}$/m);

  assert.equal(
    workflow.split(tokenReference).length - 1,
    1,
    "only the signed-commit step may reference the token output",
  );
});
