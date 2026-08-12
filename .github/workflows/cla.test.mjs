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
