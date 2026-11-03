import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditWorkflowDirectory, findNonLinuxFullSuites } from "./non-linux-full-suite.mjs";

const directory = new URL(".", import.meta.url);
const workflow = readFileSync(new URL("./rust-napi-release.yml", import.meta.url), "utf8");

test("release builds the supported native targets and tests every host", () => {
  for (const target of [
    "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc",
  ]) assert.match(workflow, new RegExp(`target: ${target}`));
  assert.match(workflow, /os: \[ubuntu-latest, macos-15, windows-latest\]/u);
  assert.match(workflow, /binding-test-directory:[^]*?default: "__test__"/u);
});

test("release runs the full suite only on Linux and scopes other hosts to bindings", () => {
  assert.match(workflow, /if: runner\.os == 'Linux'\n        run: bun test/u);
  assert.match(workflow, /if: runner\.os != 'Linux'[^]*?run: bun test "\.\/\$BINDING_TEST_DIRECTORY"/u);
  assert.deepEqual(findNonLinuxFullSuites(workflow), []);
});

test("workflow contract enumerates every literal and matrix non-Linux violation", () => {
  const violatingFixture = `jobs:
  windows-test:
    runs-on: windows-latest
    steps:
      - run: bun test
  matrix-test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-15]
    steps:
      - run: bun test --coverage
  linux-test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
  scoped-macos:
    runs-on: macos-15
    steps:
      - run: bun test ./__test__
`;
  assert.deepEqual(findNonLinuxFullSuites(violatingFixture), ["windows-test", "matrix-test"]);
});

test("repository workflows never run a full bun suite on a non-Linux runner", () => {
  assert.deepEqual(auditWorkflowDirectory(directory), []);
});
