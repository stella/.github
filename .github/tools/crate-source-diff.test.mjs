import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { diffCrateSources } from "./crate-source-diff.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "crate-source-diff.mjs");

const crateSource = {
  "Cargo.toml": '[package]\nname = "example-core"\nversion = "1.2.3"\n',
  "Cargo.toml.orig": '[package]\nname = "example-core"\nversion.workspace = true\n',
  "Cargo.lock": "version = 4\n",
  "src/lib.rs": "pub fn matches() -> bool { true }\n",
  ".cargo_vcs_info.json": '{"git":{"sha1":"1111111111111111111111111111111111111111"},"path_in_vcs":"crates/core"}\n',
};

const packCrate = (t, files, { mtime = 1_153_704_088, modes = {} } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "crate-source-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "example-core-1.2.3");
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    chmodSync(file, modes[path] ?? 0o644);
    utimesSync(file, mtime, mtime);
  }
  const crate = join(directory, "example-core-1.2.3.crate");
  execFileSync("tar", ["-czf", crate, "-C", directory, "example-core-1.2.3"]);
  return crate;
};

test("identical sources match despite archive timestamps and a different packaging commit", (t) => {
  const published = packCrate(t, crateSource);
  const rebuilt = packCrate(
    t,
    {
      ...crateSource,
      ".cargo_vcs_info.json":
        '{"git":{"sha1":"2222222222222222222222222222222222222222"},"path_in_vcs":"crates/core"}\n',
    },
    { mtime: 1_800_000_000 },
  );
  assert.deepEqual(diffCrateSources(published, rebuilt), []);
});

test("a changed source file is reported", (t) => {
  const published = packCrate(t, crateSource);
  const rebuilt = packCrate(t, { ...crateSource, "src/lib.rs": "pub fn matches() -> bool { false }\n" });
  assert.deepEqual(diffCrateSources(published, rebuilt), ["example-core-1.2.3/src/lib.rs"]);
});

test("a changed permission bit is reported even when the bytes match", (t) => {
  const withScript = { ...crateSource, "build-helper.sh": "#!/bin/sh\nexit 0\n" };
  const published = packCrate(t, withScript, { modes: { "build-helper.sh": 0o755 } });
  const rebuilt = packCrate(t, withScript, { modes: { "build-helper.sh": 0o644 } });
  assert.deepEqual(diffCrateSources(published, rebuilt), ["example-core-1.2.3/build-helper.sh"]);
  assert.deepEqual(diffCrateSources(published, packCrate(t, withScript, { modes: { "build-helper.sh": 0o755 } })), []);
});

test("added and removed files are reported from either side", (t) => {
  const { "Cargo.lock": _lock, ...withoutLock } = crateSource;
  const published = packCrate(t, withoutLock);
  const rebuilt = packCrate(t, { ...crateSource, "src/extra.rs": "\n" });
  assert.deepEqual(diffCrateSources(published, rebuilt), [
    "example-core-1.2.3/Cargo.lock",
    "example-core-1.2.3/src/extra.rs",
  ]);
  assert.deepEqual(diffCrateSources(rebuilt, published), [
    "example-core-1.2.3/Cargo.lock",
    "example-core-1.2.3/src/extra.rs",
  ]);
});

test("a VCS record outside the crate root is compared as source", (t) => {
  const published = packCrate(t, crateSource);
  const rebuilt = packCrate(t, { ...crateSource, "src/.cargo_vcs_info.json": "{}\n" });
  assert.deepEqual(diffCrateSources(published, rebuilt), ["example-core-1.2.3/src/.cargo_vcs_info.json"]);
});

test("the CLI exits 0 for identical sources, 1 with the differing paths, 2 on unreadable input", (t) => {
  const published = packCrate(t, crateSource);
  const same = spawnSync(process.execPath, [cli, published, packCrate(t, crateSource, { mtime: 1 })], {
    encoding: "utf8",
  });
  assert.equal(same.status, 0);
  assert.equal(same.stdout, "");

  const changed = packCrate(t, { ...crateSource, "Cargo.lock": "version = 3\n" });
  const different = spawnSync(process.execPath, [cli, published, changed], { encoding: "utf8" });
  assert.equal(different.status, 1);
  assert.equal(different.stdout, "example-core-1.2.3/Cargo.lock\n");

  const missing = spawnSync(process.execPath, [cli, published, join(dirname(published), "absent.crate")], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
});

test("a non-regular archive entry fails instead of being skipped", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crate-source-link-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "example-core-1.2.3");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/lib.rs"), "\n");
  symlinkSync("lib.rs", join(root, "src/alias.rs"));
  const crate = join(directory, "example-core-1.2.3.crate");
  execFileSync("tar", ["-czf", crate, "-C", directory, "example-core-1.2.3"]);
  assert.throws(() => diffCrateSources(crate, crate), /non-regular entry: example-core-1\.2\.3\/src\/alias\.rs/);
});
