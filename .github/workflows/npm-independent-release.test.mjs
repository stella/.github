import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("./npm-independent-release.yml", import.meta.url),
  "utf8",
);

test("GitHub App tokens use the supported client-id input", () => {
  assert.match(
    workflow,
    /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/,
  );
  assert.match(
    workflow,
    /client-id: \$\{\{ secrets\.RELEASE_APP_ID \}\}/,
  );
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
});
