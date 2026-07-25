import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  discoverInheritedPackages,
  synchronizeLockText,
  synchronizeWorkspace,
} from "./sync.mjs";

const workspaces = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

const fixture = ({ inherited = true, lineEnding = "\n" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "cargo-workspace-lock-"));
  workspaces.push(root);
  const manifests = {
    dotted: join(root, "crates", "dotted", "Cargo.toml"),
    inline: join(root, "crates", "inline", "Cargo.toml"),
    explicit: join(root, "crates", "explicit", "Cargo.toml"),
    external: join(root, "registry", "external", "Cargo.toml"),
  };
  for (const path of Object.values(manifests)) {
    mkdirSync(join(path, ".."), { recursive: true });
  }
  writeFileSync(
    manifests.dotted,
    inherited
      ? '[package]\nname = "dotted"\nversion.workspace = true\n'
      : '[package]\nname = "dotted"\nversion = "1.0.0"\n',
  );
  writeFileSync(
    manifests.inline,
    '[package]\nname = "inline"\nversion = { workspace = true } # inherited\n',
  );
  writeFileSync(
    manifests.explicit,
    '[package]\nname = "explicit"\nversion = "7.7.7"\n',
  );
  writeFileSync(
    manifests.external,
    '[package]\nname = "external"\nversion.workspace = true\n',
  );

  const packages = [
    {
      id: "dotted 2.0.0 (path+file:///dotted)",
      name: "dotted",
      version: "2.0.0",
      manifest_path: manifests.dotted,
    },
    {
      id: "inline 2.0.0 (path+file:///inline)",
      name: "inline",
      version: "2.0.0",
      manifest_path: manifests.inline,
    },
    {
      id: "explicit 7.7.7 (path+file:///explicit)",
      name: "explicit",
      version: "7.7.7",
      manifest_path: manifests.explicit,
    },
    {
      id: "external 2.0.0 (registry+https://example.invalid)",
      name: "external",
      version: "2.0.0",
      manifest_path: manifests.external,
    },
  ];
  const metadata = {
    workspace_members: packages.slice(0, 3).map(({ id }) => id),
    packages,
  };
  const lockfilePath = join(root, "Cargo.lock");
  const lock = [
    "# generated",
    "[[package]]",
    'name = "dotted"',
    'version = "1.9.9"',
    "",
    "[[package]]",
    'name = "inline"',
    'version = "2.0.0"',
    "",
    "[[package]]",
    'name = "explicit"',
    'version = "7.7.7"',
    "",
    "[[package]]",
    'name = "dotted"',
    'version = "9.9.9"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    "",
  ].join(lineEnding);
  writeFileSync(lockfilePath, lock);
  return { lock, lockfilePath, metadata, root };
};

test("discovers both Cargo inheritance spellings and only workspace members", () => {
  const { metadata } = fixture();
  assert.deepEqual(discoverInheritedPackages(metadata), [
    { name: "dotted", version: "2.0.0" },
    { name: "inline", version: "2.0.0" },
  ]);
});

for (const lineEnding of ["\n", "\r\n"]) {
  test(`write mode preserves ${JSON.stringify(lineEnding)} and is idempotent`, () => {
    const { lockfilePath, metadata } = fixture({ lineEnding });
    const first = synchronizeWorkspace({
      mode: "write",
      manifestPath: "unused",
      lockfilePath,
      metadata,
    });
    assert.equal(first.changed, true);
    const updated = readFileSync(lockfilePath, "utf8");
    assert.match(updated, /name = "dotted"\r?\nversion = "2\.0\.0"/);
    assert.match(
      updated,
      /name = "dotted"\r?\nversion = "9\.9\.9"\r?\nsource =/,
    );
    assert.match(updated, /name = "explicit"\r?\nversion = "7\.7\.7"/);
    assert.equal(updated.includes(lineEnding), true);
    if (lineEnding === "\r\n") {
      assert.equal(/(^|[^\r])\n/.test(updated), false);
    }

    const second = synchronizeWorkspace({
      mode: "write",
      manifestPath: "unused",
      lockfilePath,
      metadata,
    });
    assert.equal(second.changed, false);
    assert.equal(readFileSync(lockfilePath, "utf8"), updated);
  });
}

test("check mode reports all drift without writing", () => {
  const { lock, lockfilePath, metadata } = fixture();
  metadata.packages[1].version = "2.0.1";
  assert.throws(
    () =>
      synchronizeWorkspace({
        mode: "check",
        manifestPath: "unused",
        lockfilePath,
        metadata,
      }),
    (error) => {
      assert.match(error.message, /dotted: Cargo\.lock has 1\.9\.9; expected 2\.0\.0/);
      assert.match(error.message, /inline: Cargo\.lock has 2\.0\.0; expected 2\.0\.1/);
      return true;
    },
  );
  assert.equal(readFileSync(lockfilePath, "utf8"), lock);
});

test("fails when no workspace package inherits the version", () => {
  const { metadata } = fixture({ inherited: false });
  metadata.workspace_members = [metadata.packages[0].id, metadata.packages[2].id];
  assert.throws(
    () => discoverInheritedPackages(metadata),
    /no packages inheriting workspace\.package\.version/,
  );
});

test("fails on missing and duplicate local package entries", () => {
  const packages = [{ name: "core", version: "3.0.0" }];
  assert.throws(
    () =>
      synchronizeLockText(
        '[[package]]\nname = "other"\nversion = "1.0.0"\n',
        packages,
      ),
    /local entry for inherited package 'core'; found 0/,
  );
  assert.throws(
    () =>
      synchronizeLockText(
        '[[package]]\nname = "core"\nversion = "2.0.0"\n\n' +
          '[[package]]\nname = "core"\nversion = "2.1.0"\n',
        packages,
      ),
    /local entry for inherited package 'core'; found 2/,
  );
});

test("fails on malformed version fields and mixed line endings", () => {
  const packages = [{ name: "core", version: "3.0.0" }];
  assert.throws(
    () => synchronizeLockText('[[package]]\nname = "core"\n', packages),
    /exactly one version field; found 0/,
  );
  assert.throws(
    () =>
      synchronizeLockText(
        '[[package]]\r\nname = "core"\nversion = "2.0.0"\r\n',
        packages,
      ),
    /mixed LF and CRLF/,
  );
});
