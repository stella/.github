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
const selection = scriptFor("Select compiler parity");

test("parity is conditional while typecheck and rejection remain unconditional", () => {
  assert.match(job, /- name: Check compiler parity\n        if: steps.parity.outputs.run == 'true'\n        run: bun run check:typecheck-parity/u);
  assert.match(job, /fetch-depth: 0/u);
  assert.match(job, /github.event.pull_request.base.sha \|\| github.event.merge_group.base_sha \|\| github.event.before/u);
  for (const name of ["version-check", "lint", "runtime-compat", "rust-checks", "provenance", "build", "test"]) {
    const section = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][\w-]*:\n/u)[0];
    assert.match(section, /if: inputs.trusted == 'true' && !inputs.typecheck-only/u);
  }
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
]) {
  test(`parity version selection: ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "napi-parity-selection-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "package.json"), JSON.stringify(head));
      writeFileSync(join(root, "base.json"), JSON.stringify(base));
      writeFileSync(join(root, "bin/git"), `#!/bin/bash\n${base === null ? "exit 1" : 'cat "$BASE_MANIFEST"'}\n`, { mode: 0o755 });
      const output = join(root, "output");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", selection], {
        cwd: root,
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, BASE_MANIFEST: join(root, "base.json"), PARITY_MODE: mode, BASE_SHA: sha, GITHUB_OUTPUT: output },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, success, result.stderr);
      if (success) assert.equal(readFileSync(output, "utf8"), `run=${changed}\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("typechecking is opt-in, trust-gated, read-only, and independent of Rust change selection", () => {
  assert.match(workflow, /      typecheck:\n[^]*?        type: boolean\n        default: false/u);
  assert.match(job, /name: Typecheck and parity\n    if: inputs.trusted == 'true' && inputs.typecheck/u);
  assert.match(job, /permissions:\n      contents: read/u);
  assert.doesNotMatch(job, /needs:|inputs\.(?:rust|build|provenance)-changed|continue-on-error:/u);
  assert.match(job, /persist-credentials: false/u);
  assert.match(job, /bun-version-file: package.json/u);
  for (const action of job.matchAll(/uses: ([^\n]+)/gu)) {
    assert.match(action[1], /@[0-9a-f]{40}(?: |$)/u);
  }
  const commands = ["${{ inputs.install-command }}", "bun run check:toolchain", "bun run typecheck", "Reject a seeded type error", "Select compiler parity", "bun run check:typecheck-parity"];
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
