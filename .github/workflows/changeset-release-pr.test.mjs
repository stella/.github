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

test("version PR mutations use latest-run branch concurrency", () => {
  assert.match(
    workflow,
    /concurrency:\n {6}group: changeset-release-pr-\$\{\{ github\.ref \}\}\n {6}cancel-in-progress: true/,
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
      /if: inputs\.sync-cargo-inherited-lock \|\| inputs\.prepare-rust-wasm/g,
    )?.length,
    2,
  );
  assert.match(
    workflow,
    /if: inputs\.prepare-rust-wasm\n {8}name: Prepare locked Rust Wasm toolchain/,
  );
});

test("Rust Wasm preparation uses the caller's locked dependency graph", () => {
  assert.match(workflow, /rustup target add wasm32-unknown-unknown/);
  assert.match(workflow, /cargo metadata \\\n {14}--locked/);
  assert.match(workflow, /CARGO_MANIFEST_PATH: \$\{\{ inputs\.cargo-manifest \}\}/);
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

test("stale source revisions cannot mint credentials or mutate release PRs", () => {
  const freshness = indexOf("name: Check release source is current");
  const token = indexOf("name: Mint version PR token");
  const release = indexOf("name: Create or update version packages PR");

  assert.ok(freshness < token);
  assert.ok(freshness < release);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    workflow,
    /git\/ref\/heads\/\$GITHUB_REF_NAME[\s\S]+?if \[\[ "\$current_sha" == "\$GITHUB_SHA" \]\]/,
  );
  assert.match(
    workflow,
    /if: steps\.source\.outputs\.current == 'true'\n {8}name: Mint version PR token/,
  );
  assert.match(
    workflow,
    /if: steps\.source\.outputs\.current == 'true'\n {8}name: Create or update version packages PR/,
  );
});

test("a current no-op run removes the stale release PR and branch", () => {
  const cleanup = workflow.match(
    / {6}- if: >-\n {10}steps\.source\.outputs\.current == 'true'[\s\S]+?(?=\n {6}- |\n\S|$)/,
  )?.[0];

  assert.ok(cleanup, "missing stale release cleanup step");
  assert.match(
    cleanup,
    /steps\.changesets\.outputs\.pullRequestNumber == ''/,
  );
  assert.match(cleanup, /name: Remove stale version packages PR/);
  assert.match(cleanup, /current_sha="\$\(\n {12}gh api/);
  assert.match(cleanup, /if \[\[ "\$current_sha" != "\$GITHUB_SHA" \]\]/);
  assert.match(cleanup, /-f base="\$BASE_BRANCH"/);
  assert.match(cleanup, /-f head="\$owner:\$RELEASE_BRANCH"/);
  assert.match(cleanup, /-f per_page=1/);
  assert.match(cleanup, /-f state=closed/);
  assert.match(cleanup, /git\/refs\/heads\/\$RELEASE_BRANCH/);
});
