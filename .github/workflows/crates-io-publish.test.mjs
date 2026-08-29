import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("./crates-io-publish.yml", import.meta.url), "utf8");
const publisher = readFileSync(new URL("../tools/publish-crate.sh", import.meta.url), "utf8");

test("crate packaging is isolated from publishing credentials", () => {
  const packageJob = workflow.slice(workflow.indexOf("  package:"), workflow.indexOf("  attest:"));
  const publishJob = workflow.slice(workflow.indexOf("  publish:"));
  assert.doesNotMatch(packageJob, /id-token:\s*write/);
  assert.match(packageJob, /cargo package --locked/);
  assert.doesNotMatch(publishJob, /cargo (?:install|package|publish)/);
  assert.doesNotMatch(publishJob, /bun install|npm install/);
  assert.doesNotMatch(publishJob, /repository: \$\{\{ github\.repository \}\}/);
  assert.match(packageJob, /name: crate-release-\$\{\{ inputs\.crate-name \}\}/);
  assert.match(packageJob, /path: core-crate\/\*\.crate/);
});

test("crate publishing performs one immutable PUT and verifies exact bytes", () => {
  assert.equal((publisher.match(/--request PUT/g) ?? []).length, 1);
  assert.match(publisher, /--data-binary @"\$\{upload\}"/);
  assert.match(publisher, /sha256sum/);
  assert.match(publisher, /exact_archive_is_visible ambiguous/);
  assert.match(publisher, /exact_archive_is_visible published/);
  assert.doesNotMatch(publisher, /--request PUT[\s\S]{0,160}--retry/);
});

test("all privileged third-party actions are immutable", () => {
  assert.match(workflow, /rust-lang\/crates-io-auth-action@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  for (const use of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(use[1], /@[0-9a-f]{40}$/);
  }
});
