import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("./rust-napi-ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  typecheck:\n")[1]?.split("\n  runtime-compat:\n")[0];
assert.ok(job);
const scriptFor = (name) => job.split(`      - name: ${name}\n`)[1].split("        run: |\n")[1].split(/\n      - /u)[0].split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
const probe = scriptFor("Reject a seeded type error");

test("typecheck has no compiler parity mode and gates no other job", () => {
  assert.doesNotMatch(workflow, /parity|typecheck-only/iu);
  assert.doesNotMatch(job, /fetch-depth|BASE_SHA|git show/u);
  for (const name of ["version-check", "lint", "runtime-compat", "detect-rust", "detect"]) {
    const section = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][\w-]*:\n/u)[0];
    assert.match(section, /if: inputs.trusted == 'true'\n/u);
  }
});

test("typechecking is opt-in, trust-gated, read-only, and independent of Rust change selection", () => {
  assert.match(workflow, /      typecheck:\n[^]*?        type: boolean\n        default: false/u);
  assert.match(job, /name: Typecheck\n    if: inputs.trusted == 'true' && inputs.typecheck/u);
  assert.match(job, /permissions:\n      contents: read/u);
  assert.doesNotMatch(job, /needs:|inputs\.(?:rust|build|provenance)-changed|continue-on-error:/u);
  assert.match(job, /persist-credentials: false/u);
  assert.match(job, /bun-version-file: package.json/u);
  for (const action of job.matchAll(/uses: ([^\n]+)/gu)) {
    assert.match(action[1], /@[0-9a-f]{40}(?: |$)/u);
  }
  const commands = ["bun install --frozen-lockfile", "bun run check:toolchain", "bun run typecheck", "Reject a seeded type error"];
  for (let index = 1; index < commands.length; index++) {
    assert.ok(job.indexOf(commands[index - 1]) < job.indexOf(commands[index]));
  }
});

for (const [scenario, output, status, accepted] of [
  ["seeded assignment error", '$file(1,14): error TS2322: Type number is not assignable to string.', 1, true],
  ["checker succeeds", '$file(1,14): error TS2322: ignored', 0, false],
  ["unrelated assignment error", 'other.ts(1,14): error TS2322: unrelated', 1, false],
  ["wrong diagnostic", '$file(1,14): error TS2307: missing dependency', 1, false],
  ["no diagnostics", '', 1, false],
]) {
  test(`seed probe checks the diagnostic and removes its source: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "napi-typecheck-"));
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin", "bun"), `#!/bin/bash\nfile=$(basename src/typecheck-rejection-*.ts)\nprintf '%s\\n' "${output}"\nexit ${status}\n`, { mode: 0o755 });
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", probe], {
        cwd: root,
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, accepted, result.stdout + result.stderr);
      assert.deepEqual(readdirSync(join(root, "src")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const sectionFor = (name) => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/u)[0];
const detect = sectionFor("detect");
const build = sectionFor("build");
const artifactTest = sectionFor("test");
const detectScript = detect.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");

for (const value of ["true", "false", "", "TRUE", "true\n", "$(exit 1)"]) {
  test(`build selection normalizes the caller flag ${JSON.stringify(value)}`, () => {
    const root = mkdtempSync(join(tmpdir(), "napi-build-selection-"));
    try {
      const output = join(root, "output");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", detectScript], {
        env: { ...process.env, BUILD_CHANGED: value, GITHUB_OUTPUT: output },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), `build-changed=${value === "true"}\n`);
      assert.equal(result.stdout.includes("::notice::"), value !== "true");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

const buildJobs = [...workflow.matchAll(/^  ([\w-]+):\n    name: Build - ([^\n]+)/gmu)].map((match) => ({ id: match[1], target: match[2], section: sectionFor(match[1]) }));
const testJobs = [...workflow.matchAll(/^  ([\w-]+):\n    name: Test \(([^)]+)\)/gmu)].map((match) => ({ id: match[1], os: match[2], section: sectionFor(match[1]) }));

test("static required check names survive skipping before runner allocation", () => {
  // Effective main-branch rules in aho-corasick, regex-set and fuzzy-search
  // require these names under the caller's `napi-ci / ` prefix.
  const required = [
    "Build - x86_64-apple-darwin", "Build - aarch64-apple-darwin",
    "Build - x86_64-unknown-linux-gnu", "Build - aarch64-unknown-linux-gnu",
    "Build - wasm32-wasip1-threads", "Test (ubuntu-latest)", "Test (macos-15)",
  ];
  const declared = [...buildJobs, ...testJobs].map(({ section }) => section.match(/    name: ([^\n]+)/u)[1]);
  assert.deepEqual(declared.toSorted(), required.toSorted());
  for (const { section } of [...buildJobs, ...testJobs]) {
    assert.doesNotMatch(section, /matrix|strategy:|always\(|!cancelled\(/u);
    assert.match(section, /if: inputs.trusted == 'true' && needs.detect.outputs.build-changed == 'true'\n/u);
    assert.doesNotMatch(section, /inputs.build-changed|Skip /u);
  }
});

test("one permission-free selection job gates all build and test jobs", () => {
  assert.match(workflow, /      build-changed:\n[^]*?        type: string\n        default: "true"/u);
  assert.match(detect, /if: inputs.trusted == 'true'\n/u);
  assert.match(detect, /permissions: \{\}/u);
  assert.match(detect, /build-changed: \$\{\{ steps.select.outputs.build-changed \}\}/u);
  assert.match(detect, /BUILD_CHANGED: \$\{\{ inputs.build-changed \}\}/u);
  assert.doesNotMatch(detect, /uses:|matrix:|checkout|install-command/u);
  for (const { section } of buildJobs) assert.match(section, /needs: \[detect\]/u);
  for (const { section } of testJobs) {
    const needs = section.match(/needs: \[([^\]]+)\]/u)[1].split(", ");
    assert.deepEqual(needs.toSorted(), ["detect", ...buildJobs.map(({ id }) => id)].toSorted());
  }
});

test("build jobs share steps and keep target, runner and build kind consistent", () => {
  assert.match(build, /steps: &build-steps/u);
  for (const { id, target, section } of buildJobs) {
    const envTarget = section.match(/BUILD_TARGET: ([^\n]+)/u)[1];
    assert.equal(envTarget, target, "artifact target must match the required check");
    const kind = section.match(/BUILD_KIND: ([^\n]+)/u)[1];
    assert.equal(kind, target.startsWith("wasm") ? "wasm" : target === "aarch64-unknown-linux-gnu" ? "cross" : "native");
    assert.match(section, /RUSTUP_TOOLCHAIN: 1\.99\.0/u);
    assert.equal(section.match(/runs-on: ([^\n]+)/u)[1], target.includes("apple") ? "macos-15" : "ubuntu-latest");
    if (id !== "build") assert.match(section, /steps: \*build-steps/u);
  }
  assert.match(build, /targets: \$\{\{ env.BUILD_TARGET \}\}/u);
  assert.match(build, /shared-key: build-\$\{\{ env.BUILD_TARGET \}\}/u);
  assert.match(build, /if: >-\n          env.BUILD_KIND == 'native'/u);
  assert.match(build, /if: env.BUILD_KIND == 'cross'\n[^]*?--use-napi-cross/u);
  assert.match(build, /if: env.BUILD_KIND == 'wasm'\n        run: bun run build:wasm/u);
  assert.match(build, /name: bindings-\$\{\{ env.BUILD_TARGET \}\}/u);
  assert.match(build, /path: \|\n            \*\.node\n            \*\.wasm\n            !\*\.debug.wasm\n            \*\.cjs\n            \*\.wasi-browser.js\n            wasi-worker\*\.mjs\n          if-no-files-found: error/u);
});

test("test jobs share artifact handling and run extra property tests only on Linux", () => {
  assert.match(artifactTest, /steps: &test-steps/u);
  for (const { id, os, section } of testJobs) {
    assert.equal(section.match(/runs-on: ([^\n]+)/u)[1], os);
    if (id !== "test") assert.match(section, /steps: \*test-steps/u);
  }
  assert.match(artifactTest, /uses: actions\/download-artifact@[0-9a-f]{40}[^]*?path: artifacts/u);
  assert.match(artifactTest, /for dir in artifacts\/bindings-\*; do/u);
  assert.match(artifactTest, /- run: bun test/u);
  assert.match(artifactTest, /if: >-\n          runner.os == 'Linux'\n          && inputs.property-test-command != ''/u);
  assert.match(artifactTest, /run: \$PROPERTY_TEST_CMD\n        env:\n          PROPERTY_TEST_CMD: \$\{\{ inputs.property-test-command \}\}/u);
});

test("Rust checks lint and test every workspace crate, as release verification does", () => {
  const section = workflow.split("\n  rust-checks:\n")[1].split(/\n  [a-z][\w-]*:\n/u)[0];
  const cargoRuns = section.match(/run: cargo (?:clippy|test)\b.*/gu) ?? [];
  assert.equal(cargoRuns.length, 2);
  for (const run of cargoRuns) {
    assert.match(run, / --locked /u);
    assert.match(run, / --workspace /u);
    assert.match(run, / --all-targets --all-features/u);
  }
});

test("dependency installation preserves and enforces lockfile integrity", () => {
  assert.match(workflow, /      install-ignore-scripts:\n[^]*?        type: boolean\n        default: false/u);
  assert.doesNotMatch(workflow, /install-command|eval /u);
  const installs = [...workflow.matchAll(/      - name: Install dependencies\n([^]*?)(?=\n      - )/gu)].map((match) => match[1]);
  assert.equal(installs.length, 6);
  for (const install of installs) {
    assert.match(install, /bun install --frozen-lockfile --ignore-scripts/u);
    assert.match(install, /bun install --frozen-lockfile\n/u);
    assert.doesNotMatch(install, /INSTALL_COMMAND|eval/u);
  }

  const root = mkdtempSync(join(tmpdir(), "napi-install-"));
  try {
    mkdirSync(join(root, "bin"));
    const calls = join(root, "calls");
    writeFileSync(join(root, "bin/bun"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$CALLS"\n`, { mode: 0o755 });
    const install = installs[0].split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", install], {
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CALLS: calls, INSTALL_COMMAND: "bun install --no-'verify'", INSTALL_IGNORE_SCRIPTS: "false" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(calls, "utf8"), "install --frozen-lockfile\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust change selection includes lockfiles and manifests", () => {
  assert.match(workflow, /rust-changed:\n        description: "[^"]*caller requests Rust checks in addition to the workflow’s manifest, lockfile, toolchain, crate, and Rust source detection\."\n        required: false\n        type: string\n        default: "true"/u);
  const rustChecks = sectionFor("rust-checks");
  assert.match(rustChecks, /inputs\.rust-changed == 'true' \|\| needs\.detect-rust\.outputs\.rust-changed == 'true'/u);
  assert.match(rustChecks, /needs: \[detect-rust\]/u);

  const rustDetect = sectionFor("detect-rust");
  assert.match(rustDetect, /fetch-depth: 0/u);
  assert.match(rustDetect, /git merge-base HEAD "\$BASE_SHA"/u);
  for (const path of ["Cargo.toml", "Cargo.lock", "**/Cargo.toml", "**/Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "crates/**", "src/**/*.rs"]) {
    assert.ok(rustDetect.includes(`'${path}'`), `missing Rust change path ${path}`);
  }

  const root = mkdtempSync(join(tmpdir(), "napi-rust-selection-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "Cargo.lock"), "version = 3\n");
    spawnSync("git", ["add", "Cargo.lock"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    writeFileSync(join(root, "Cargo.lock"), "version = 4\n");
    spawnSync("git", ["commit", "-qam", "lockfile"], { cwd: root });
    const output = join(root, "output");
    const script = rustDetect.split("      - name: Select Rust checks\n")[1].split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: root,
      env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: output, RUST_CHANGED: "false" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), "rust-changed=true\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
