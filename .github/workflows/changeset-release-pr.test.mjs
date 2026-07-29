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
