import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowDefaults = new Map([
  ["changeset-release-pr.yml", "ubuntu-latest"],
  ["dependabot-bun-dedupe.yml", "ubuntu-24.04"],
]);

for (const [workflowFile, hostedDefault] of workflowDefaults) {
  test(`${workflowFile} supports a JSON runner label array with a hosted default`, async () => {
    const workflow = await readFile(new URL(workflowFile, import.meta.url), "utf8");
    const runnerInput = `      runs-on:
        description: "Runner labels as a JSON array"
        required: false
        type: string
        default: '["${hostedDefault}"]'`;

    assert.ok(workflow.includes(runnerInput), "missing runs-on workflow input");
    assert.match(
      workflow,
      /runs-on: \$\{\{ fromJSON\(inputs\.runs-on\) \}\}/,
    );
    assert.doesNotMatch(workflow, /^ {4}runs-on: ubuntu-latest$/m);
  });
}
