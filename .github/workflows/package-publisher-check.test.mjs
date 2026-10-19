import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      message: "package @stll/time is published from stella/tooling; consume it instead of keeping a copy",
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

test("repository URL forms normalize to owner/name", () => {
  for (const value of ["stella/tooling", "github:stella/tooling", "git+https://github.com/stella/tooling.git", "git@github.com:stella/tooling.git"]) {
    assert.equal(normalizeRepository(value), "stella/tooling");
  }
});

test("shared entry points invoke the composite action", async () => {
  const files = ["rust-napi-ci.yml", "npm-version-preflight.yml"];
  for (const file of files) {
    const workflow = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(workflow, /uses: stella\/.github\/actions\/package-publisher-check@main/u);
  }
  const action = await readFile(new URL("../../actions/typescript-checks/action.yml", import.meta.url), "utf8");
  assert.match(action, /package-publisher-check\.mjs/u);
});
