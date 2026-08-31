import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(
  new URL("dependabot-bun-dedupe.yml", import.meta.url),
  "utf8",
);

test("private fetch authorization is scoped to the autofix action process", () => {
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /echo "::add-mask::\$\{authorization\}"/);
  assert.match(
    workflow,
    /GIT_CONFIG_KEY_0: http\.https:\/\/github\.com\/\.extraheader/,
  );
  assert.match(
    workflow,
    /GIT_CONFIG_VALUE_0: \$\{\{ env\.AUTOFIX_GIT_AUTHORIZATION \}\}/,
  );
  assert.doesNotMatch(workflow, /permissions:\n\s+contents: write/);
});
