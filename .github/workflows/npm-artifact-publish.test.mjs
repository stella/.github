import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("./npm-artifact-publish.yml", import.meta.url), "utf8");
const action = readFileSync(
  new URL("../actions/npm-publish-hardened/action.yml", import.meta.url),
  "utf8",
);
const publisher = readFileSync(
  new URL("../actions/npm-publish-hardened/publish.sh", import.meta.url),
  "utf8",
);

test("npm artifact publication validates caller-declared identity", () => {
  assert.match(workflow, /expected-name: \$\{\{ inputs\.package-name \}\}/);
  assert.match(workflow, /expected-version: \$\{\{ inputs\.version \}\}/);
  assert.match(action, /EXPECTED_NAME: \$\{\{ inputs\.expected-name \}\}/);
  assert.match(publisher, /actual_name.*EXPECTED_NAME/);
  assert.match(publisher, /actual_version.*EXPECTED_VERSION/);
});

test("the OIDC workflow installs only pinned npm without lifecycle scripts", () => {
  assert.match(workflow, /npm install --global --ignore-scripts npm@11\.11\.1/);
  assert.doesNotMatch(workflow, /bun install|npm ci|npm install(?! --global --ignore-scripts)/);
});
