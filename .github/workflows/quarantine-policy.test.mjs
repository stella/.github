import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const workflowFiles = ["quarantine-policy.yml", "quarantine-prune.yml"];
const parseYaml = (file) =>
  JSON.parse(
    execFileSync(
      "bun",
      [
        "-e",
        "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))",
        file,
      ],
      { encoding: "utf8" },
    ),
  );
const defaults = workflowFiles.map((name) => {
  const workflow = parseYaml(fileURLToPath(new URL(name, import.meta.url)));
  return workflow.on.workflow_call.inputs["bun-roots"].default;
});
const checkEntry = fileURLToPath(
  new URL("../actions/quarantine-policy/check.ts", import.meta.url),
);
const noBunOutput =
  "sparse-checkout<<BUN_ROOTS_OUTPUT\n\nBUN_ROOTS_OUTPUT\n" +
  "prune-paths<<BUN_ROOTS_OUTPUT\n" +
  "pnpm-workspace.yaml\n.cargo/quarantine.toml\nBUN_ROOTS_OUTPUT\n" +
  "allowed-path-regex=^(pnpm-workspace\\.yaml|\\.cargo/quarantine\\.toml)$\n";
const rootBunOutput =
  "sparse-checkout<<BUN_ROOTS_OUTPUT\n" +
  "bun.lock\nbunfig.toml\npackage.json\nBUN_ROOTS_OUTPUT\n" +
  "prune-paths<<BUN_ROOTS_OUTPUT\n" +
  "bunfig.toml\npnpm-workspace.yaml\n.cargo/quarantine.toml\nBUN_ROOTS_OUTPUT\n" +
  "allowed-path-regex=^(bunfig\\.toml|pnpm-workspace\\.yaml|\\.cargo/quarantine\\.toml)$\n";

const runCli = (root, bunRoots) => {
  const output = join(root, "github-output");
  const result = spawnSync("bun", [checkEntry, "--bun-roots-output"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BUN_ROOTS: bunRoots, GITHUB_OUTPUT: output },
  });
  return {
    ...result,
    output: result.status === 0 ? readFileSync(output, "utf8") : undefined,
  };
};

test("workflow Bun root defaults drive automatic CLI discovery", () => {
  assert.deepEqual(defaults, ["", ""], "both workflows must default to empty");

  for (const [name, file, body, expected] of [
    ["Cargo", "Cargo.lock", "version = 3\n", noBunOutput],
    ["pnpm", "pnpm-lock.yaml", "lockfileVersion: '9.0'\n", noBunOutput],
    ["root Bun", "bun.lock", '{"packages":{}}', rootBunOutput],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "quarantine-workflow-default-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      writeFileSync(join(root, file), body);
      spawnSync("git", ["add", file], { cwd: root });
      const result = runCli(root, defaults[0]);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(result.output, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an explicit root still fails closed without a tracked root Bun lock", () => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-explicit-root-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "Cargo.lock"), "version = 3\n");
    spawnSync("git", ["add", "Cargo.lock"], { cwd: root });
    const result = runCli(root, ".");
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /invalid Bun root "\.": bun\.lock is not tracked/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
