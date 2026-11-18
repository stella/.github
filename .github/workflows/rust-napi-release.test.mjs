import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditWorkflowDirectory, findNonLinuxFullSuites } from "./non-linux-full-suite.mjs";

const directory = new URL(".", import.meta.url);
const workflow = readFileSync(new URL("./rust-napi-release.yml", import.meta.url), "utf8");
const sectionFor = (name) => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/u)[0];
const build = sectionFor("build");
const testJob = sectionFor("test");
const stepScript = (section, name) =>
  section.split(`      - name: ${name}\n`)[1].split("        run: |\n")[1].split(/\n      - /u)[0]
    .split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");

test("release builds every published target with its runner and build kind", () => {
  const targets = [...build.matchAll(/- target: (\S+)\n\s+os: (\S+)\n\s+kind: (\S+)/gu)]
    .map(([, target, os, kind]) => `${target} ${os} ${kind}`);
  assert.deepEqual(targets, [
    "x86_64-apple-darwin macos-15 native",
    "aarch64-apple-darwin macos-15 native",
    "x86_64-unknown-linux-gnu ubuntu-24.04 native",
    "aarch64-unknown-linux-gnu ubuntu-24.04 cross",
    "x86_64-pc-windows-msvc windows-latest native",
    "wasm32-wasip1-threads ubuntu-24.04 wasm",
  ]);
  assert.match(build, /name: Build - \$\{\{ matrix.target \}\}/u);
  assert.match(build, /if: matrix.kind == 'cross'\n[^]*?--use-napi-cross/u);
  assert.match(build, /if: matrix.kind == 'wasm'\n        run: bun run build:wasm/u);
  assert.match(build, /name: bindings-\$\{\{ matrix.target \}\}\n          path: "\*\.node"/u);
  assert.match(build, /name: bindings-\$\{\{ matrix.target \}\}\n          path: \$\{\{ inputs.wasm-artifact-paths \}\}/u);
  assert.doesNotMatch(build, /run: .*\$\{\{/u, "target values reach the shell through env");
  assert.match(build, /targets: \$\{\{ matrix.target \}\}\n      - name: Ensure cargo on PATH\n[^]*?if: runner.os != 'Windows'\n        shell: bash\n        run: echo "\$HOME\/.cargo\/bin" >> "\$GITHUB_PATH"/u);
});

test("release tests every host and keeps checkouts and pins immutable", () => {
  assert.match(testJob, /needs: \[build\]/u);
  assert.match(testJob, /os: \[ubuntu-24.04, macos-15, windows-latest\]/u);
  assert.match(testJob, /pattern: bindings-\*\n          path: artifacts/u);
  assert.match(workflow, /binding-test-directory:[^]*?default: "__test__"/u);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  for (const use of workflow.matchAll(/uses: ([^\n]+)/gu)) assert.match(use[1], /@[0-9a-f]{40}(?: |$)/u);
  assert.equal(workflow.match(/persist-credentials: false/gu).length, 2);
  assert.doesNotMatch(workflow, /secrets|id-token|contents: write|workflow_dispatch|eval /u);
});

test("release runs the full suite only on Linux and scopes other hosts to bindings", () => {
  assert.match(testJob, /if: runner\.os == 'Linux'\n        run: bun test\n/u);
  assert.match(testJob, /if: runner\.os != 'Linux'\n        shell: bash\n[^]*?run: bun test "\.\/\$BINDING_TEST_DIRECTORY"/u);
  assert.match(testJob, /if: runner.os == 'Linux' && inputs.property-test-command != ''/u);
  assert.deepEqual(findNonLinuxFullSuites(workflow), []);
});

test("pre-test commands run word by word without shell evaluation", () => {
  const script = stepScript(testJob, "Prepare tests");
  const root = mkdtempSync(join(tmpdir(), "napi-release-pretest-"));
  try {
    mkdirSync(join(root, "bin"));
    const calls = join(root, "calls");
    writeFileSync(join(root, "bin", "bun"), `#!/bin/bash\nprintf '%s|' "$@" >> "$CALLS"\nprintf '\\n' >> "$CALLS"\n`, { mode: 0o755 });
    const run = (commands) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CALLS: calls, PRE_TEST_COMMANDS: commands },
      encoding: "utf8",
    });
    const result = run("bun run build:js\n\n  bun run test:single-thread $(touch pwned)\n");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(calls, "utf8"), "run|build:js|\nrun|test:single-thread|$(touch|pwned)|\n");
    assert.equal(spawnSync("test", ["-e", join(root, "pwned")]).status, 1);
    writeFileSync(join(root, "bin", "bun"), "#!/bin/bash\nexit 3\n", { mode: 0o755 });
    assert.notEqual(run("bun run build:js").status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("single-thread WebAssembly travels as its own optional artifact", () => {
  assert.match(workflow, /      single-thread-wasm:\n[^]*?        default: ""/u);
  assert.match(build, /if: matrix.kind == 'wasm' && inputs.single-thread-wasm != ''\n[^]*?name: single-thread-wasm\n          path: \$\{\{ inputs.single-thread-wasm \}\}/u);
  assert.match(testJob, /if: inputs.single-thread-wasm != ''\n        with:\n          name: single-thread-wasm\n          path: \./u);
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
      - name: Suite
        run: bun test --coverage
  block-test:
    runs-on: macos-15
    steps:
      - name: Suite
        run: |
          bun install
          bun test
  linux-test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
  gated-matrix:
    runs-on: \${{ matrix.os }}
    steps:
      - name: Suite
        if: runner.os == 'Linux'
        run: bun test
  scoped-macos:
    runs-on: macos-15
    steps:
      - run: bun test ./__test__
`;
  assert.deepEqual(findNonLinuxFullSuites(violatingFixture), ["windows-test", "matrix-test", "block-test"]);
});

test("repository workflows never run a full bun suite on a non-Linux runner", () => {
  assert.deepEqual(auditWorkflowDirectory(directory), []);
});
