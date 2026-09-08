import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("./changeset-release-pr.yml", import.meta.url),
  "utf8",
);

const indexOf = (text) => {
  const index = workflow.indexOf(text);
  assert.notEqual(index, -1, `missing workflow contract: ${text}`);
  return index;
};

test("version PR mutations finish under branch concurrency", () => {
  assert.match(
    workflow,
    /concurrency:\n {6}group: changeset-release-pr-\$\{\{ github\.ref \}\}\n {6}cancel-in-progress: false/,
  );
});

test("Rust Wasm preparation is explicit and disabled by default", () => {
  const input = workflow.match(
    / {6}prepare-rust-wasm:\n[\s\S]+?(?= {4}secrets:)/,
  )?.[0];
  assert.ok(input, "missing prepare-rust-wasm input");
  assert.match(input, /required: false/);
  assert.match(input, /type: boolean/);
  assert.match(input, /default: false/);
  assert.equal(
    workflow.match(
      /if: steps\.lifecycle\.outputs\.status == 'mutable' && \(inputs\.sync-cargo-inherited-lock \|\| inputs\.prepare-rust-wasm\)/g,
    )?.length,
    2,
  );
  assert.match(
    workflow,
    /if: steps\.lifecycle\.outputs\.status == 'mutable' && inputs\.prepare-rust-wasm\n {8}name: Prepare locked Rust Wasm toolchain/,
  );
});

test("Rust Wasm preparation uses the caller's locked dependency graph", () => {
  assert.match(workflow, /rustup target add wasm32-unknown-unknown/);
  assert.match(workflow, /cargo metadata \\\n {14}--locked/);
  assert.match(
    workflow,
    /CARGO_MANIFEST_PATH: \$\{\{ inputs\.cargo-manifest \}\}/,
  );
  assert.match(workflow, /--manifest-path "\$CARGO_MANIFEST_PATH"/);
  assert.match(workflow, /select\(\.name == "wasm-bindgen"\)/);
  assert.match(
    workflow,
    /cargo install wasm-bindgen-cli --version "\$\{versions\[0\]\}" --locked/,
  );
});

test("tool installation precedes the write-capable release credential", () => {
  const preparation = indexOf("name: Prepare locked Rust Wasm toolchain");
  const token = indexOf("name: Mint version PR token");
  assert.ok(preparation < token);
});

test("GitHub App tokens use the supported client-id input", () => {
  assert.match(
    workflow,
    /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/,
  );
  assert.match(workflow, /client-id: \$\{\{ secrets\.CHANGELOG_APP_ID \}\}/);
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
});

test("changesets/action uses the v2 interface", () => {
  const changesets = workflow.match(
    / {6}- if: steps\.lifecycle\.outputs\.status == 'mutable'\n {8}name: Create or update version packages PR[\s\S]+?(?=\n {6}- |\n\S|$)/,
  )?.[0];

  assert.ok(changesets, "missing changesets/action step");
  assert.match(
    workflow,
    /repository: changesets\/action\n {10}ref: [0-9a-f]{40} # v2\.\d+\.\d+$/m,
  );
  assert.match(
    changesets,
    /INPUT_GITHUB-TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/,
  );
  assert.match(
    changesets,
    /INPUT_VERSION-SCRIPT: bash \$\{\{ steps\.version-command\.outputs\.path \}\}/,
  );
  assert.match(changesets, /INPUT_PR-TITLE: \$\{\{ inputs\.title \}\}/);
  assert.match(changesets, /INPUT_COMMIT-MESSAGE: \$\{\{ inputs\.commit \}\}/);
  assert.doesNotMatch(changesets, /GITHUB_TOKEN:/);
});

test("stale source revisions cannot mint credentials or mutate release PRs", () => {
  const freshness = indexOf("name: Inspect release lifecycle");
  const token = indexOf("name: Mint version PR token");
  const release = indexOf("name: Create or update version packages PR");

  assert.ok(freshness < token);
  assert.ok(freshness < release);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    workflow,
    /if: steps\.lifecycle\.outputs\.status == 'mutable'\n {8}name: Mint version PR token/,
  );
  assert.match(
    workflow,
    /if: steps\.lifecycle\.outputs\.status == 'mutable'\n {8}name: Create or update version packages PR/,
  );
});

test("only a completed mutable version run may clean up or hand off", () => {
  const cleanup = workflow.match(
    / {6}- if: >-[\s\S]+?name: Remove stale version packages PR[\s\S]+?(?=\n {6}- |$)/,
  )?.[0];
  assert.ok(cleanup);
  assert.match(cleanup, /steps\.changesets\.outputs\.status == 'mutable'/);
  assert.match(cleanup, /steps\.changesets\.outputs\.pr-number == ''/);
  assert.match(cleanup, /node "\$LIFECYCLE_SCRIPT" cleanup/);
  assert.match(
    workflow,
    /steps\.changesets\.outputs\.pr-number != '' && inputs\.auto-merge-command != ''/,
  );
  assert.match(workflow, /node "\$LIFECYCLE_SCRIPT" merge/);
  assert.doesNotMatch(workflow, /continue-on-error|--admin/);
});

test("release freeze is checked before installation and again at every mutation", () => {
  assert.ok(
    indexOf("name: Inspect release lifecycle") < indexOf("run: bun install"),
  );
  assert.match(
    workflow,
    /uses: stella\/\.github\/\.github\/actions\/changeset-release-lifecycle@[0-9a-f]{40}/,
  );
  assert.match(workflow, /run: node "\$LIFECYCLE_SCRIPT" version/);
  assert.ok(
    indexOf('mv .changesets-action "$action_path"') <
      indexOf("name: Create or update version packages PR"),
  );
});
