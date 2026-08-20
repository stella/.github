import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowFiles = ["ai-shared-update.yml", "changeset-release-pr.yml"];

for (const workflowFile of workflowFiles) {
  test(`${workflowFile} supports a JSON runner label array with a hosted default`, async () => {
    const workflow = await readFile(new URL(workflowFile, import.meta.url), "utf8");
    const runnerInput = workflow.match(
      / {6}runs-on:\n[\s\S]+?(?=\n {6}[a-z][a-z-]+:|\n {4}secrets:)/,
    )?.[0];

    assert.ok(runnerInput, "missing runs-on workflow input");
    assert.match(runnerInput, /required: false/);
    assert.match(runnerInput, /type: string/);
    assert.match(runnerInput, /default: '\["ubuntu-latest"\]'/);
    assert.match(
      workflow,
      /runs-on: \$\{\{ fromJSON\(inputs\.runs-on\) \}\}/,
    );
    assert.doesNotMatch(workflow, /^ {4}runs-on: ubuntu-latest$/m);
  });
}
