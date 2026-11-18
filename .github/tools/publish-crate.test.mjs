import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const publisher = join(dirname(fileURLToPath(import.meta.url)), "publish-crate.sh");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const source = {
  "Cargo.toml": '[package]\nname = "example-core"\nversion = "1.2.3"\n',
  "src/lib.rs": "pub fn matches() -> bool { true }\n",
  ".cargo_vcs_info.json": '{"git":{"sha1":"1111111111111111111111111111111111111111"},"path_in_vcs":"crates/core"}\n',
};

// Answers the version lookup and archive download like crates.io; any upload attempt is recorded and refused.
const fakeCurl = `#!/usr/bin/env bash
output=""
url=""
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */crates/new) echo upload >> "$FAKE_UPLOADS"; printf 500 ;;
  */download) cp "$FAKE_PUBLISHED_CRATE" "$output"; printf 200 ;;
  *) printf '{"version":{"num":"1.2.3"}}' > "$output"; printf 200 ;;
esac
`;

const setup = (t) => {
  const directory = mkdtempSync(join(tmpdir(), "publish-crate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), fakeCurl);
  chmodSync(join(bin, "curl"), 0o755);
  mkdirSync(join(directory, "runner-temp"));

  let packed = 0;
  const pack = (files) => {
    const work = join(directory, `pack-${packed++}`);
    const root = join(work, "example-core-1.2.3");
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    const crate = join(work, "example-core-1.2.3.crate");
    execFileSync("tar", ["-czf", crate, "-C", work, "example-core-1.2.3"]);
    return crate;
  };

  const crateDirectory = join(directory, "core-crate");
  mkdirSync(crateDirectory);
  const prepared = readFileSync(pack(source));
  const upload = Buffer.concat([Buffer.from("metadata"), prepared]);
  writeFileSync(join(crateDirectory, "example-core-1.2.3.crate"), prepared);
  writeFileSync(join(crateDirectory, "upload.bin"), upload);
  writeFileSync(
    join(crateDirectory, "release.json"),
    JSON.stringify({
      name: "example-core",
      version: "1.2.3",
      crateFile: "example-core-1.2.3.crate",
      crateSha256: sha256(prepared),
      uploadFile: "upload.bin",
      uploadSha256: sha256(upload),
    }),
  );

  const uploads = join(directory, "uploads.log");
  const outputs = join(directory, "github-output");
  const reusedDirectory = join(directory, "published-crate");
  const run = (publishedCrate) =>
    spawnSync("bash", ["-eo", "pipefail", publisher], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: join(directory, "runner-temp"),
        CRATE_DIRECTORY: crateDirectory,
        EXPECTED_CRATE_NAME: "example-core",
        FAKE_PUBLISHED_CRATE: publishedCrate,
        FAKE_UPLOADS: uploads,
        GITHUB_OUTPUT: outputs,
        PUBLISHED_ARCHIVE_DIRECTORY: reusedDirectory,
      },
    });
  const readOutputs = () =>
    Object.fromEntries(
      readFileSync(outputs, "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  return {
    pack,
    run,
    readOutputs,
    reusedDirectory,
    preparedSha: sha256(prepared),
    preparedPath: join(crateDirectory, "example-core-1.2.3.crate"),
    uploads,
  };
};

test("an existing version with the exact prepared bytes is skipped", (t) => {
  const { run, readOutputs, preparedSha, preparedPath, uploads } = setup(t);
  const result = run(preparedPath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /already published with the exact prepared bytes/);
  assert.equal(existsSync(uploads), false);
  assert.deepEqual(readOutputs(), { "published-sha256": preparedSha, "reused-archive": "" });
});

test("an existing version packaged from another commit with identical source is skipped", (t) => {
  const { pack, run, readOutputs, reusedDirectory, preparedSha, uploads } = setup(t);
  const published = pack({
    ...source,
    ".cargo_vcs_info.json": '{"git":{"sha1":"2222222222222222222222222222222222222222"},"path_in_vcs":"crates/core"}\n',
  });
  const result = run(published);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /already published from identical source; skipping upload/);
  assert.equal(existsSync(uploads), false);
  // The reported digest and the archive handed to attestation are the registry's bytes, not the prepared ones.
  const publishedBytes = readFileSync(published);
  const reused = join(reusedDirectory, "example-core-1.2.3.crate");
  assert.notEqual(sha256(publishedBytes), preparedSha);
  assert.deepEqual(readOutputs(), { "published-sha256": sha256(publishedBytes), "reused-archive": reused });
  assert.ok(readFileSync(reused).equals(publishedBytes));
});

test("an existing version with different source fails and names the differing files", (t) => {
  const { pack, run, uploads } = setup(t);
  const published = pack({ ...source, "src/lib.rs": "pub fn matches() -> bool { false }\n" });
  const result = run(published);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /already published from different source; release a new version/);
  assert.match(result.stdout, /example-core-1\.2\.3\/src\/lib\.rs/);
  assert.equal(existsSync(uploads), false);
});

test("the workflow reports and attests the archive crates.io serves", () => {
  const workflow = readFileSync(new URL("../workflows/crates-io-publish.yml", import.meta.url), "utf8");
  assert.match(
    workflow,
    /crate-sha256:\n\s+description: [^\n]+\n\s+value: \$\{\{ jobs\.publish\.outputs\.published-sha256 \}\}/,
  );
  const attestJob = workflow.slice(workflow.indexOf("  attest-published:"));
  assert.match(attestJob, /if: needs\.publish\.outputs\.reused-archive != ''/);
  assert.match(attestJob, /sha256sum --check --strict/);
  assert.match(attestJob, /subject-path: published-crate\/\*\.crate/);
});

test("an unreadable published archive fails without uploading", (t) => {
  const { run, uploads } = setup(t);
  const notACrate = join(mkdtempSync(join(tmpdir(), "publish-crate-bad-")), "bad.crate");
  t.after(() => rmSync(dirname(notACrate), { recursive: true, force: true }));
  writeFileSync(notACrate, "not a gzip archive");
  const result = run(notACrate);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Could not compare the published example-core 1\.2\.3 archive/);
  assert.equal(existsSync(uploads), false);
});
