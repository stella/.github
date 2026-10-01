import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("./pr-lint.yml", import.meta.url);
const manifestUrl = new URL("../../labels.yml", import.meta.url);

const jsonInput = (workflow, name) => {
  const input = workflow.match(new RegExp(`^ {10}${name}: '(?<json>.+)'$`, "mu"));
  assert.ok(input?.groups?.["json"], `${name} input not found`);
  return JSON.parse(input.groups["json"]);
};

test("every PR title type labels with a label the org manifest declares", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const manifest = await readFile(manifestUrl, "utf8");
  const taskTypes = jsonInput(workflow, "task_types");
  const customLabels = jsonInput(workflow, "custom_labels");
  const declared = new Set(
    [...manifest.matchAll(/^- name: "(?<name>[^"]+)"$/gmu)].map((m) => m.groups["name"]),
  );

  for (const type of Object.keys(customLabels)) {
    assert.ok(taskTypes.includes(type), `custom label for unknown type ${type}`);
  }
  for (const type of taskTypes) {
    const label = customLabels[type] ?? type;
    assert.ok(declared.has(label), `type ${type} applies undeclared label ${label}`);
  }
});
