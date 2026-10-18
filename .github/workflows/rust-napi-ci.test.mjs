import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const yaml = (path) => Bun.YAML.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const workflow = yaml("./rust-napi-ci.yml");
const typecheckAction = yaml("../actions/napi-typecheck/action.yml");
const buildAction = yaml("../actions/napi-build/action.yml");
const { jobs } = workflow;
const inputs = workflow.on.workflow_call.inputs;
const steps = (owner) => owner.runs?.steps ?? owner.steps;
const named = (owner, name) => {
  const step = steps(owner).find((item) => item.name === name);
  assert.ok(step, `missing step: ${name}`);
  return step;
};
const using = (job, action) => {
  const step = steps(job).find((item) => item.uses === action);
  assert.ok(step, `${job.name} must use ${action}`);
  return step;
};
const probe = named(typecheckAction, "Reject a seeded type error").run;
const selection = named(typecheckAction, "Select compiler parity").run;

test("parity is conditional while typecheck and rejection remain unconditional", () => {
  assert.equal(named(typecheckAction, "Reject a seeded type error").if, undefined);
  assert.equal(named(typecheckAction, "Select compiler parity").if, undefined);
  assert.equal(named(typecheckAction, "Check compiler parity").if, "steps.parity.outputs.run == 'true'");
  assert.deepEqual(steps(typecheckAction).filter((step) => step.run).map((step) => step.run), [
    "bun run check:toolchain", "bun run typecheck", probe, selection, "bun run check:typecheck-parity",
  ]);
  assert.equal(using(jobs.typecheck, "./.github/actions/napi-typecheck").with["base-sha"], "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}");
  for (const id of ["version-check", "lint", "runtime-compat", "rust-checks", "provenance", "build", "test"])
    assert.match(jobs[id].if, /inputs\.scope == 'full' && inputs\.trusted == 'true' && !inputs\.typecheck-only/u);
});

const manifest = { packageManager: "bun@1.4.3", devDependencies: { typescript: "7.0.2", "@stll/oxlint-config": "0.10.0" } };
for (const [name, head, base, mode, sha, changed, success] of [
  ["same versions", manifest, manifest, "changed", "a".repeat(40), false, true],
  ["ordinary package edit", { ...manifest, version: "2.0.0" }, manifest, "changed", "a".repeat(40), false, true],
  ["Bun bump", { ...manifest, packageManager: "bun@1.4.4" }, manifest, "changed", "a".repeat(40), true, true],
  ["TypeScript bump", { ...manifest, devDependencies: { typescript: "7.0.3" } }, manifest, "changed", "a".repeat(40), true, true],
  ["nightly", manifest, manifest, "always", "", true, true],
  ["missing base", manifest, manifest, "changed", "", true, true],
  ["initial push", manifest, manifest, "changed", "0".repeat(40), true, true],
  ["unreadable base", manifest, null, "changed", "a".repeat(40), true, true],
  ["invalid mode", manifest, manifest, "never", "a".repeat(40), undefined, false],
]) test(`parity version selection: ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "napi-parity-selection-"));
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "package.json"), JSON.stringify(head));
    writeFileSync(join(root, "base.json"), JSON.stringify(base));
    writeFileSync(join(root, "bin/git"), `#!/bin/bash\n${base === null ? "exit 1" : 'cat "$BASE_MANIFEST"'}\n`, { mode: 0o755 });
    const output = join(root, "output");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", selection], { cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, BASE_MANIFEST: join(root, "base.json"), PARITY_MODE: mode, BASE_SHA: sha, GITHUB_OUTPUT: output }, encoding: "utf8" });
    assert.equal(result.status === 0, success, result.stderr);
    if (success) assert.equal(readFileSync(output, "utf8"), `run=${changed}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("typechecking is opt-in, trust-gated, read-only, and independent of Rust change selection", () => {
  assert.deepEqual(inputs.typecheck, { description: "Run typecheck and a seeded-error rejection probe", required: false, type: "boolean", default: false });
  assert.equal(jobs.typecheck.if, "inputs.scope == 'full' && inputs.trusted == 'true' && inputs.typecheck");
  assert.deepEqual(jobs.typecheck.permissions, { contents: "read" });
  assert.equal(jobs.typecheck.needs, undefined);
  assert.doesNotMatch(jobs.typecheck.if, /inputs\.(?:rust|build|provenance)-changed|continue-on-error/u);
  const checkout = jobs.typecheck.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, { "fetch-depth": 0, "persist-credentials": false });
  assert.equal(jobs.typecheck.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.with["bun-version-file"], "package.json");
  for (const step of jobs.typecheck.steps.filter((candidate) => candidate.uses && !candidate.uses.startsWith("./"))) assert.match(step.uses, /@[0-9a-f]{40}$/u);
  assert.deepEqual(jobs.typecheck.steps.map((step) => step.run ?? step.uses), [checkout.uses, jobs.typecheck.steps[1].uses, "${{ inputs.install-command }}", "./.github/actions/napi-typecheck"]);
});

test("PR typechecking is opt-in and uses the same implementation", () => {
  const step = using(jobs.pr, "./.github/actions/napi-typecheck");
  assert.equal(step.if, "inputs.typecheck");
  assert.deepEqual(step.with, { parity: "${{ inputs.parity }}", "base-sha": "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}" });
  assert.equal(jobs.pr.steps.find((candidate) => candidate.uses?.startsWith("actions/checkout@"))?.with["persist-credentials"], false);
});

for (const [scenario, output, status, accepted] of [
  ["seeded assignment error", '$file(1,14): error TS2322: Type number is not assignable to string.', 1, true],
  ["checker succeeds", '$file(1,14): error TS2322: ignored', 0, false],
  ["unrelated assignment error", 'other.ts(1,14): error TS2322: unrelated', 1, false],
  ["wrong diagnostic", '$file(1,14): error TS2307: missing dependency', 1, false],
  ["no diagnostics", '', 1, false],
]) test(`seed probe checks the diagnostic and removes its source: ${scenario}`, () => {
  assert.equal(named(typecheckAction, "Reject a seeded type error").if, undefined);
  const root = mkdtempSync(join(tmpdir(), "napi-typecheck-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/bun"), `#!/bin/bash\nfile=$(basename src/typecheck-rejection-*.ts)\nprintf '%s\\n' "${output}"\nexit ${status}\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", probe], { cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root }, encoding: "utf8" });
    assert.equal(result.status === 0, accepted, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(join(root, "src")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const detectScript = named(jobs.detect, "Select build and artifact tests").run;
for (const value of ["true", "false", "", "TRUE", "true\n", "$(exit 1)"]) test(`build selection normalizes the caller flag ${JSON.stringify(value)}`, () => {
  const root = mkdtempSync(join(tmpdir(), "napi-build-selection-"));
  try {
    const output = join(root, "output");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", detectScript], { env: { ...process.env, BUILD_CHANGED: value, GITHUB_OUTPUT: output }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), `build-changed=${value === "true"}\n`);
    assert.equal(result.stdout.includes("::notice::"), value !== "true");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const buildJobs = Object.entries(jobs).filter(([, job]) => job.name?.startsWith("Build - ")).map(([id, job]) => ({ id, job, target: job.name.slice(8) }));
const testJobs = Object.entries(jobs).filter(([, job]) => job.name?.startsWith("Test (")).map(([id, job]) => ({ id, job, os: job.name.slice(6, -1) }));

test("static required check names survive skipping before runner allocation", () => {
  const required = ["Build - x86_64-apple-darwin", "Build - aarch64-apple-darwin", "Build - x86_64-unknown-linux-gnu", "Build - aarch64-unknown-linux-gnu", "Build - wasm32-wasip1-threads", "Test (ubuntu-latest)", "Test (macos-15)"];
  assert.deepEqual([...buildJobs, ...testJobs].map(({ job }) => job.name).toSorted(), required.toSorted());
  for (const { job } of [...buildJobs, ...testJobs]) {
    assert.equal(job.strategy, undefined); assert.doesNotMatch(job.if, /always\(|!cancelled\(/u);
    assert.equal(job.if, "inputs.scope == 'full' && inputs.trusted == 'true' && !inputs.typecheck-only && needs.detect.outputs.build-changed == 'true'");
  }
});

test("one permission-free selection job gates all build and test jobs", () => {
  assert.equal(inputs["build-changed"].default, "true");
  assert.equal(jobs.detect.if, "inputs.scope == 'full' && inputs.trusted == 'true' && !inputs.typecheck-only");
  assert.deepEqual(jobs.detect.permissions, {});
  assert.deepEqual(jobs.detect.outputs, { "build-changed": "${{ steps.select.outputs.build-changed }}" });
  assert.equal(named(jobs.detect, "Select build and artifact tests").env.BUILD_CHANGED, "${{ inputs.build-changed }}");
  assert.ok(jobs.detect.steps.every((step) => !step.uses));
  for (const { job } of buildJobs) assert.deepEqual(job.needs, ["detect"]);
  for (const { job } of testJobs) assert.deepEqual(job.needs.toSorted(), ["detect", ...buildJobs.map(({ id }) => id)].toSorted());
});

test("build jobs share steps and keep target, runner and build kind consistent", () => {
  for (const { target, job } of buildJobs) {
    assert.equal(job.env.BUILD_TARGET, target);
    assert.equal(job.env.BUILD_KIND, target.startsWith("wasm") ? "wasm" : target === "aarch64-unknown-linux-gnu" ? "cross" : "native");
    assert.equal(job.env.RUSTUP_TOOLCHAIN, "1.99.0");
    assert.equal(job["runs-on"], target.includes("apple") ? "macos-15" : "ubuntu-latest");
    assert.deepEqual(job.steps, jobs.build.steps);
    assert.deepEqual(using(job, "./.github/actions/napi-build").with, { target: "${{ env.BUILD_TARGET }}", kind: "${{ env.BUILD_KIND }}", "node-version": "${{ inputs.node-version }}", "install-command": "${{ inputs.install-command }}" });
  }
  const actionSteps = steps(buildAction);
  assert.equal(actionSteps.find((step) => step.uses?.startsWith("dtolnay/rust-toolchain@"))?.with.targets, "${{ inputs.target }}");
  assert.equal(actionSteps.find((step) => step.uses?.startsWith("Swatinem/rust-cache@"))?.with["shared-key"], "build-${{ inputs.target }}-${{ inputs.toolchain }}");
  assert.equal(actionSteps.find((step) => step.if === "inputs.kind == 'native'")?.run, "bun run build --target ${{ inputs.target }}");
  assert.match(actionSteps.find((step) => step.if === "inputs.kind == 'cross'")?.run, /--use-napi-cross/u);
  assert.equal(actionSteps.find((step) => step.if === "inputs.kind == 'wasm'")?.run, "bun run build:wasm");
  const upload = jobs.build.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.name, "bindings-${{ env.BUILD_TARGET }}");
  assert.equal(upload.with.path, "*.node\n*.wasm\n!*.debug.wasm\n*.cjs\n*.wasi-browser.js\nwasi-worker*.mjs\n");
  assert.equal(upload.with["if-no-files-found"], "error");
});

test("test jobs share artifact handling and run extra property tests only on Linux", () => {
  for (const { job, os } of testJobs) { assert.equal(job["runs-on"], os); assert.deepEqual(job.steps, jobs.test.steps); }
  assert.equal(jobs.test.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))?.with.path, "artifacts");
  assert.match(named(jobs.test, "Move artifacts").run, /for dir in artifacts\/bindings-\*; do/u);
  assert.ok(jobs.test.steps.some((step) => step.run === "bun test"));
  const property = named(jobs.test, "Property tests");
  assert.equal(property.if, "runner.os == 'Linux' && inputs.property-test-command != ''");
  assert.equal(property.run, "$PROPERTY_TEST_CMD"); assert.equal(property.env.PROPERTY_TEST_CMD, "${{ inputs.property-test-command }}");
});

test("PR job runs property tests only when supplied", () => {
  const property = named(jobs.pr, "Property tests");
  assert.equal(property.if, "inputs.build-changed == 'true' && inputs.property-test-command != ''");
  assert.equal(property.run, "$PROPERTY_TEST_CMD"); assert.equal(property.env.PROPERTY_TEST_CMD, "${{ inputs.property-test-command }}");
});
