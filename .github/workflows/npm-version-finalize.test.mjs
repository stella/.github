import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("./npm-version-finalize.yml", import.meta.url),
  "utf8",
);

test("the npm OIDC job does not persist a write-capable checkout token", () => {
  assert.match(
    workflow,
    /- uses: actions\/checkout@[0-9a-f]{40} # v6\n\s+with:\n\s+fetch-depth: 0\n\s+persist-credentials: false\n\s+token:/,
  );
});

test("the release App token requests only repository contents write", () => {
  assert.match(
    workflow,
    /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/,
  );
  assert.match(
    workflow,
    /client-id: \$\{\{ secrets\.RELEASE_APP_ID \|\| secrets\.CHANGELOG_APP_ID \}\}/,
  );
  assert.match(workflow, /permission-contents: write/);
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
});

test("the only install in the npm OIDC job disables lifecycle scripts", () => {
  const installCommands = workflow.match(/^\s+run: .*\binstall\b.*$/gm);
  assert.deepEqual(installCommands, [
    "        run: npm install --global --ignore-scripts npm@11.11.1",
  ]);
});
