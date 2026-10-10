import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import path from "node:path";

const workflow = readFileSync(new URL("./package-consumer-compat.yml", import.meta.url), "utf8");
const runBlock = (name) => {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `Missing step: ${name}`);
  const next = workflow.indexOf("\n      - ", start + 1);
  const step = workflow.slice(start, next < 0 ? undefined : next);
  const run = step.indexOf("        run: |\n");
  assert.ok(run >= 0, `Missing run block: ${name}`);
  return step
    .slice(run + "        run: |\n".length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
};

test("consumer checks use a read-only hosted runner and published tooling input", () => {
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /secrets:|write-all|issues: write|id-token: write/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  for (const name of ["packages", "consumer-node", "tooling-version", "fixture-path"])
    assert.match(
      workflow,
      new RegExp(
        `      ${name}:\\n        description: .+\\n        required: true\\n        type: string`,
      ),
    );
  assert.match(runBlock("Install published consumer runner"), /cd "\$tooling_dir"/);
  assert.match(
    runBlock("Install published consumer runner"),
    /--ignore-scripts --omit=peer --package-lock=false/,
  );
  assert.match(
    runBlock("Install published consumer runner"),
    /"@stll\/oxlint-config@\$TOOLING_VERSION"/,
  );
});

test("nightly event gate rejects PR and push callers instead of silently skipping", () => {
  const script = runBlock("Validate nightly invocation");
  for (const event of ["schedule", "workflow_dispatch", "pull_request", "push"]) {
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        CONSUMER_NODE: "22.23.3",
        TOOLING_VERSION: "1.2.3",
      },
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      ["schedule", "workflow_dispatch"].includes(event) ? 0 : 1,
      result.stderr,
    );
  }
  for (const TOOLING_VERSION of ["main", "1.2.3-rc.1", "^1.2.3", "01.2.3"]) {
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "schedule",
        CONSUMER_NODE: "22.23.3",
        TOOLING_VERSION,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
  }
});

test("caller builds once on tracked development runtime; consumer Node is provisioned by the runner", () => {
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(workflow, /bun-version-file: package\.json/);
  assert.match(workflow, /assert\.equal\(process\.versions\.node\.split\('\.'\)\[0\], '26'/);
  assert.equal((workflow.match(/uses: actions\/setup-node@/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /node-version:|setup-node[^\n]*22/);
  assert.equal((workflow.match(/bun install --frozen-lockfile/g) ?? []).length, 1);
  assert.equal((workflow.match(/bun run build/g) ?? []).length, 1);
});

test("workflow validates actual JSON package selections and fixture paths before building", () => {
  const script = runBlock("Validate caller runtime and fixture inputs");
  const match = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/.exec(script);
  assert.ok(match?.[1], "missing input parser heredoc");
  const source = match[1].replace(/^import .*;\n/gm, "");
  const validate = (packages, fixture = "fixtures/consumer", node = "26.0.0") =>
    runInNewContext(source, {
      assert,
      path,
      process: { versions: { node }, env: { PACKAGE_PATHS: packages, FIXTURE_PATH: fixture } },
    });
  validate('["packages/library"]');
  validate('["."]');
  for (const packages of [
    "[]",
    "[null]",
    '["../library"]',
    '["packages/library","./packages/library"]',
  ])
    assert.throws(() => validate(packages));
  assert.throws(() => validate('["packages/library"]', "../fixtures"));
  assert.throws(() => validate('["packages/library"]', "fixtures/consumer", "22.23.3"));
});

test("caller values stay in environment bindings and quoted argument positions", () => {
  for (const line of workflow.split("\n"))
    if (line.includes("${{ inputs."))
      assert.match(line, /^          [A-Z_]+: \$\{\{ inputs\.[a-z-]+ \}\}$/);
  const run = runBlock("Check packed consumers with npm and pnpm");
  assert.match(run, /--packages "\$PACKAGE_PATHS"/);
  assert.match(run, /--consumer-node "\$CONSUMER_NODE"/);
  assert.match(run, /--fixture-path "\$FIXTURE_PATH"/);
  assert.doesNotMatch(run, /eval|sh -c|bash -c/);
});

test("all action references use the shared immutable SHA pins", () => {
  const sharedWorkflow = readFileSync(
    new URL("./changeset-release-pr.yml", import.meta.url),
    "utf8",
  );
  const approved = new Map(
    [...sharedWorkflow.matchAll(/uses: ([\w/-]+)@([a-f0-9]{40})\b/g)].map(([, action, sha]) => [
      action,
      sha,
    ]),
  );
  const references = [...workflow.matchAll(/uses: ([\w/-]+)@([a-f0-9]{40})\b/g)];
  assert.equal(references.length, 3);
  for (const [, action, sha] of references) assert.equal(sha, approved.get(action));
});
