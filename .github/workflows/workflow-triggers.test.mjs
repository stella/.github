import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

// pull_request_target runs base-repository code with secrets on pull request
// events; GitHub restricts it on public repositories. Use pull_request, plus a
// workflow_run workflow for any privileged step.
test("no workflow is triggered by pull_request_target", async () => {
  const directory = new URL("./", import.meta.url);
  const offenders = [];
  for (const name of await readdir(directory)) {
    if (!/\.ya?ml$/u.test(name)) continue;
    const source = await readFile(new URL(name, directory), "utf8");
    // The top-level `on:` block: its own line plus every indented line after it.
    const triggers = source.replace(/#.*$/gmu, "").match(/^["']?on["']?:.*(?:\n(?:[ \t].*)?)*/mu)?.[0];
    assert.ok(triggers, `${name} declares no triggers`);
    if (/\bpull_request_target\b/u.test(triggers)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
