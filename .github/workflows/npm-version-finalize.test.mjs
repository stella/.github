import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NPM_RELEASE_STATE } from "../actions/npm-visibility/release-state.mjs";

const workflow = readFileSync(
  new URL("./npm-version-finalize.yml", import.meta.url),
  "utf8",
);

test("the release App credentials are required workflow secrets", () => {
  assert.match(
    workflow,
    /RELEASE_APP_ID:\n\s+description: [^\n]+\n\s+required: true/,
  );
  assert.match(
    workflow,
    /RELEASE_APP_PRIVATE_KEY:\n\s+description: [^\n]+\n\s+required: true/,
  );
});

test("the npm OIDC job does not persist a write-capable checkout token", () => {
  assert.match(
    workflow,
    /- uses: actions\/checkout@[0-9a-f]{40} # v6\n\s+with:\n\s+fetch-depth: 0\n\s+persist-credentials: false\n\s+token:/,
  );
  assert.doesNotMatch(workflow, /git\", \[\"fetch\"/);
});

test("the release App token requests only repository contents write", () => {
  assert.match(
    workflow,
    /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3(?:\.[0-9]+){2}/,
  );
  assert.match(
    workflow,
    /client-id: \$\{\{ secrets\.RELEASE_APP_ID \}\}/,
  );
  assert.match(workflow, /permission-contents: write/);
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
});

test("the finalizer exposes only release and registry capabilities", () => {
  assert.doesNotMatch(workflow, /CHANGELOG_APP|update-changelog|pull-requests:/);
  assert.doesNotMatch(workflow, /^    uses:/m);
});

test("the only install in the npm OIDC job disables lifecycle scripts", () => {
  const installCommands = workflow.match(/^\s+run: .*\binstall\b.*$/gm);
  assert.deepEqual(installCommands, [
    "        run: npm install --global --ignore-scripts npm@11.11.1",
  ]);
});

test("the finalizer publishes with its own immutable tooling checkout", () => {
  assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(
    workflow,
    /uses: \.\/\.release-tooling\/\.github\/actions\/npm-publish-hardened/,
  );
  assert.doesNotMatch(
    workflow,
    /uses: stella\/\.github\/\.github\/actions\/npm-publish-hardened@/,
  );
});

const step = (name) => {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing step ${name}`);
  const end = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
};

test("a failed npm publish fails the job before any release state is decided", () => {
  assert.doesNotMatch(workflow, /continue-on-error|always\(\)|failure\(\)/);
  assert.match(step("Publish to npm"), /\n\s+id: publish\n/);
  assert.match(
    step("Verify npm state"),
    /NPM_PUBLISH_OUTCOME: \$\{\{ steps\.publish\.outcome \}\}/,
  );
});

test("the GitHub release is published only when npm lists every version", () => {
  assert.match(step("Verify npm state"), /\n\s+id: verify\n/);
  assert.match(step("Verify npm state"), /`npm-state=\$\{decision\.state\}\\n`/);
  assert.match(
    step("Publish GitHub release"),
    new RegExp(
      `if: steps\\.validate\\.outputs\\.changed == 'true' && steps\\.verify\\.outputs\\.npm-state == '${NPM_RELEASE_STATE.visible}'\\n`,
    ),
  );
});

test("the finalizer reads npm through the shared revalidating visibility check", () => {
  assert.match(step("Verify npm state"), /readNpmVisibility\(name, version\)/);
  assert.doesNotMatch(step("Verify npm state"), /"npm", \["view"/);
});

test("the finalizer takes the version tag scheme from the shared module", () => {
  assert.match(step("Validate release assets"), /RELEASE_VERSION_PATTERN, releaseTagFor/);
  assert.doesNotMatch(workflow, /SEMVER_PATTERN|`v\$\{version\}`/);
});
