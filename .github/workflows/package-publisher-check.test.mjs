import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { checkPackagePublishers, normalizeRepository } from "../tools/package-publisher-check.mjs";

const fixture = async (manifests) => {
  const root = await mkdtemp(join(tmpdir(), "publisher-check-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: manifests[0], private: true, workspaces: ["packages/*"] }));
  for (const [index, name] of manifests.slice(1).entries()) {
    const directory = join(root, "packages", String(index));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name }));
  }
  return root;
};

const registry = async (responses) => {
  const reads = new Map();
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    reads.set(name, (reads.get(name) ?? 0) + 1);
    const value = responses[name];
    if (value === undefined) { response.writeHead(404).end(); return; }
    if (typeof value === "number") { response.writeHead(value).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { repository: value } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, reads, close: () => new Promise((resolve) => server.close(resolve)) };
};

const yamlFiles = async (directory) => (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));

const parseYaml = (file) => JSON.parse(execFileSync(
  "ruby",
  ["-rjson", "-ryaml", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV.fetch(0), aliases: false))", file],
  { encoding: "utf8" },
));

const assertPublisherChecksHaveNode = (yaml, file) => {
  const lines = yaml.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.includes("package-publisher-check.mjs")) continue;

    const runIndent = line.search(/\S/u);
    const stepsIndex = lines.findLastIndex((candidate, candidateIndex) => candidateIndex < index
      && candidate.search(/\S/u) < runIndent
      && candidate.trim() === "steps:");
    assert.notEqual(stepsIndex, -1, `${file}:${index + 1} must run inside a steps list`);

    const stepIndent = lines.slice(stepsIndex + 1, index + 1)
      .find((candidate) => /^\s+-\s/u.test(candidate))?.search(/\S/u);
    assert.notEqual(stepIndent, undefined, `${file}:${index + 1} must run inside a step`);
    const precedingSteps = lines.slice(stepsIndex + 1, index)
      .join("\n")
      .split(new RegExp(`^ {${stepIndent}}- `, "mu"));
    const setup = precedingSteps.findLast((step) => /uses: actions\/setup-node@[0-9a-f]{40}(?:\s+# v\d+(?:\.\d+){0,2})?$/mu.test(step));
    assert.ok(setup, `${file}:${index + 1} must be preceded by a pinned setup-node step`);
    const major = Number(setup.match(/node-version:\s*["']?(\d+)/u)?.[1]);
    assert.ok(major >= 22, `${file}:${index + 1} setup-node major must be at least 22`);
  }
};

test("own, unpublished, private published, scoped, and duplicate packages are checked once", async () => {
  const root = await fixture(["@stll/own", "unpublished", "@stll/own", "private-published"]);
  const fake = await registry({ "@stll/own": { url: "git+https://github.com/stella/tooling.git" }, "private-published": "stella/tooling" });
  try {
    await checkPackagePublishers({ root, repository: "stella/tooling", registry: fake.url });
    assert.deepEqual(Object.fromEntries(fake.reads), { "@stll/own": 1, unpublished: 1, "private-published": 1 });
  } finally { await fake.close(); await rm(root, { recursive: true }); }
});

test("a package published elsewhere fails with the exact message", async () => {
  const root = await fixture(["@stll/time"]);
  const fake = await registry({ "@stll/time": { url: "git+https://github.com/stella/tooling.git" } });
  try {
    await assert.rejects(checkPackagePublishers({ root, repository: "stella/stella", registry: fake.url }), {
      message: "package @stll/time is published from github.com/stella/tooling; consume it instead of keeping a copy",
    });
  } finally { await fake.close(); await rm(root, { recursive: true }); }
});

test("registry errors fail closed", async () => {
  const root = await fixture(["example"]);
  const fake = await registry({ example: 503 });
  try {
    await assert.rejects(checkPackagePublishers({ root, repository: "stella/tooling", registry: fake.url }), /failed to read npm registry for example: HTTP 503/u);
  } finally { await fake.close(); await rm(root, { recursive: true }); }
});

test("network errors fail closed with the package name", async () => {
  const root = await fixture(["example"]);
  try {
    await assert.rejects(checkPackagePublishers({
      root,
      repository: "stella/tooling",
      fetchImpl: async () => { throw new Error("connection refused"); },
    }), /failed to read npm registry for example: connection refused/u);
  } finally { await rm(root, { recursive: true }); }
});

test("repository URL forms normalize to host/owner/name", () => {
  for (const value of ["stella/tooling", "github:stella/tooling", "git+https://github.com/stella/tooling.git", "git@github.com:stella/tooling.git"]) {
    assert.equal(normalizeRepository(value), "github.com/stella/tooling");
  }
});

test("workspace brace and character-class patterns inspect published packages", async () => {
  for (const [pattern, directory] of [["packages/{core,utils}", "utils"], ["packages/[ab]", "b"]]) {
    const root = await mkdtemp(join(tmpdir(), "publisher-check-glob-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, workspaces: [pattern] }));
    await mkdir(join(root, "packages", directory), { recursive: true });
    await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify({ name: `published-${directory}` }));
    try {
      await assert.rejects(checkPackagePublishers({
        root,
        repository: "stella/tooling",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            "dist-tags": { latest: "1.0.0" },
            versions: { "1.0.0": { repository: "github:elsewhere/source" } },
          }),
        }),
      }), new RegExp(`package published-${directory} is published from github\\.com/elsewhere/source`, "u"));
    } finally { await rm(root, { recursive: true }); }
  }
});

test("negated workspace patterns exclude packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "publisher-check-negation-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*", "!packages/excluded"] }));
  await mkdir(join(root, "packages", "excluded"), { recursive: true });
  await writeFile(join(root, "packages", "excluded", "package.json"), JSON.stringify({ name: "excluded" }));
  try {
    await checkPackagePublishers({
      root,
      repository: "stella/tooling",
      fetchImpl: async () => { throw new Error("excluded package was inspected"); },
    });
  } finally { await rm(root, { recursive: true }); }
});

test("pnpm workspace packages are discovered without package.json workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "publisher-check-pnpm-"));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - !ignored/**\n");
  await mkdir(join(root, "packages", "nested"), { recursive: true });
  await writeFile(join(root, "packages", "nested", "package.json"), JSON.stringify({ name: "published-elsewhere" }));
  try {
    await assert.rejects(checkPackagePublishers({
      root,
      repository: "stella/tooling",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { repository: "github:elsewhere/source" } },
        }),
      }),
    }), /package published-elsewhere is published from github\.com\/elsewhere\/source/u);
  } finally { await rm(root, { recursive: true }); }
});

test("an explicit package file list is honored exactly", async () => {
  const root = await fixture(["ignored-root", "selected", "ignored-workspace"]);
  const fake = await registry({ selected: "stella/tooling" });
  try {
    await checkPackagePublishers({
      root,
      packageFiles: ["packages/0/package.json"],
      repository: "stella/tooling",
      registry: fake.url,
    });
    assert.deepEqual(Object.fromEntries(fake.reads), { selected: 1 });
  } finally { await fake.close(); await rm(root, { recursive: true }); }
});

test("unreadable pnpm workspace YAML fails instead of guessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "publisher-check-pnpm-invalid-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "must-not-be-used" }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
  try {
    await assert.rejects(checkPackagePublishers({
      root,
      repository: "stella/tooling",
      fetchImpl: async () => { throw new Error("root package was inspected"); },
    }), /cannot read .*pnpm-workspace\.yaml/u);
  } finally { await rm(root, { recursive: true }); }
});

test("the same repository path on another host is published elsewhere", async () => {
  const root = await fixture(["same-path"]);
  const fake = await registry({ "same-path": "https://gitlab.com/stella/tooling.git" });
  try {
    await assert.rejects(checkPackagePublishers({ root, repository: "stella/tooling", registry: fake.url }), {
      message: "package same-path is published from gitlab.com/stella/tooling; consume it instead of keeping a copy",
    });
  } finally { await fake.close(); await rm(root, { recursive: true }); }
});

test("shared entry points invoke the composite action", async () => {
  const files = ["rust-napi-ci.yml", "npm-version-preflight.yml"];
  for (const file of files) {
    const workflow = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(workflow, /uses: stella\/.github\/actions\/package-publisher-check@main/u);
  }
  const action = await readFile(new URL("../../actions/typescript-checks/action.yml", import.meta.url), "utf8");
  assert.match(action, /package-publisher-check\.mjs/u);

  const preflight = parseYaml(new URL("npm-version-preflight.yml", import.meta.url).pathname);
  const publisherStep = preflight.jobs.preflight.steps.find((step) => step.uses === "stella/.github/actions/package-publisher-check@main");
  assert.equal(publisherStep.with["package-files"], "${{ inputs.package-files }}");
});

test("composite action inputs reach its script literally through the environment", async () => {
  const actionFile = new URL("../../actions/package-publisher-check/action.yml", import.meta.url);
  const action = parseYaml(actionFile.pathname);
  const runBlocks = action.runs.steps.flatMap((step) => typeof step.run === "string" ? [step.run] : []);
  assert.ok(runBlocks.length > 0);
  for (const run of runBlocks) assert.doesNotMatch(run, /\$\{\{\s*inputs\./u);

  const root = await mkdtemp(join(tmpdir(), "publisher-check-action-"));
  const bin = join(root, "bin");
  const output = join(root, "arguments");
  await mkdir(bin);
  await writeFile(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$OUTPUT"\n`);
  await chmod(join(bin, "node"), 0o755);
  const dangerousRoot = "$(printf command-substitution-ran)";
  try {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", runBlocks.at(-1)], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: "/action",
        NPM_REGISTRY_URL: "https://registry.invalid",
        OUTPUT: output,
        PACKAGE_FILES: "",
        PACKAGE_ROOT: dangerousRoot,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(output, "utf8")).trim().split("\n"), [
      "/action/../../.github/tools/package-publisher-check.mjs",
      "--root",
      dangerousRoot,
    ]);
  } finally { await rm(root, { recursive: true }); }
});

test("every publisher check script provisions Node 22 or newer first", async () => {
  const repository = new URL("../../", import.meta.url);
  const files = [
    ...await yamlFiles(new URL(".github/workflows/", repository)),
    ...await yamlFiles(new URL("actions/", repository)),
  ];
  let checks = 0;
  for (const file of files) {
    const yaml = await readFile(file, "utf8");
    checks += yaml.match(/package-publisher-check\.mjs/gu)?.length ?? 0;
    assertPublisherChecksHaveNode(yaml, file);
  }
  assert.equal(checks, 2, "all publisher check script entry points are covered");
});
