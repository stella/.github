import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("./rust-napi-ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  typecheck:\n")[1]?.split("\n  runtime-compat:\n")[0];
assert.ok(job);
const probe = job.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");

test("typechecking is opt-in, trust-gated, read-only, and independent of Rust change selection", () => {
  assert.match(workflow, /      typecheck:\n[^]*?        type: boolean\n        default: false/u);
  assert.match(job, /name: Typecheck and parity\n    if: inputs.trusted == 'true' && inputs.typecheck/u);
  assert.match(job, /permissions:\n      contents: read/u);
  assert.doesNotMatch(job, /needs:|changed|continue-on-error:/u);
  assert.match(job, /persist-credentials: false/u);
  assert.match(job, /bun-version-file: package.json/u);
  for (const action of job.matchAll(/uses: ([^\n]+)/gu)) {
    assert.match(action[1], /@[0-9a-f]{40}(?: |$)/u);
  }
  const commands = ["${{ inputs.install-command }}", "bun run check:toolchain", "bun run typecheck", "bun run check:typecheck-parity", "Reject a seeded type error"];
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
