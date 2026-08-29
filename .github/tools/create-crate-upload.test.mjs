import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createPublishMetadata,
  createUploadArtifacts,
  validatePublishTarget,
} from "./create-crate-upload.mjs";

test("binds registry metadata and exact crate bytes into one upload payload", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crate-upload-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cratePath = join(directory, "example-core-1.2.3.crate");
  const readmePath = join(directory, "README.md");
  const cargoManifestPath = join(directory, "Cargo.toml");
  const uploadPath = join(directory, "upload.bin");
  const releaseManifestPath = join(directory, "release.json");
  const crate = Buffer.from("prebuilt crate bytes");
  writeFileSync(cratePath, crate);
  writeFileSync(readmePath, "# Example\n");

  createUploadArtifacts({
    pkg: {
      name: "example-core",
      version: "1.2.3",
      manifest_path: cargoManifestPath,
      dependencies: [
        {
          name: "aho-corasick",
          req: "^1",
          features: ["std"],
          optional: false,
          uses_default_features: true,
          target: null,
          kind: null,
          registry: null,
          rename: null,
        },
      ],
      features: {},
      authors: [],
      description: "Example",
      documentation: null,
      homepage: null,
      readme: "README.md",
      keywords: [],
      categories: [],
      license: "MIT",
      license_file: null,
      repository: null,
      links: null,
      rust_version: "1.85",
    },
    cratePath,
    uploadPath,
    manifestPath: releaseManifestPath,
  });

  const upload = readFileSync(uploadPath);
  const metadataLength = upload.readUInt32LE(0);
  const metadataEnd = 4 + metadataLength;
  const metadata = JSON.parse(upload.subarray(4, metadataEnd).toString("utf8"));
  const crateLength = upload.readUInt32LE(metadataEnd);
  const uploadedCrate = upload.subarray(metadataEnd + 4);
  const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));

  assert.equal(metadata.name, "example-core");
  assert.equal(metadata.vers, "1.2.3");
  assert.equal(metadata.readme, "# Example\n");
  assert.equal(metadata.readme_file, "README.md");
  assert.equal(metadata.deps[0].version_req, "^1");
  assert.equal(crateLength, crate.length);
  assert.deepEqual(uploadedCrate, crate);
  assert.equal(releaseManifest.crateFile, "example-core-1.2.3.crate");
  assert.equal(releaseManifest.crateSha256.length, 64);
  assert.equal(releaseManifest.uploadSha256.length, 64);
});

test("permits only unrestricted or crates.io-enabled Cargo packages", () => {
  assert.doesNotThrow(() => validatePublishTarget(null));
  assert.doesNotThrow(() => validatePublishTarget(["crates-io"]));
  assert.throws(() => validatePublishTarget([]), /does not permit publishing/);
  assert.throws(() => validatePublishTarget(["private"]), /does not permit publishing/);
});

test("rebases inherited metadata files into the packaged crate root", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crate-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageRoot = join(directory, "crates", "core");
  const readme = join(directory, "README.md");
  const license = join(directory, "LICENSE");
  writeFileSync(readme, "# Example\n");
  writeFileSync(license, "MIT\n");
  const metadata = createPublishMetadata({
    name: "example-core",
    version: "1.2.3",
    manifest_path: join(packageRoot, "Cargo.toml"),
    dependencies: [],
    features: {},
    authors: [],
    description: null,
    documentation: null,
    homepage: null,
    readme: "../../README.md",
    keywords: [],
    categories: [],
    license: null,
    license_file: "../../LICENSE",
    repository: null,
    links: null,
    rust_version: "1.85",
  });
  assert.equal(metadata.readme_file, "README.md");
  assert.equal(metadata.license_file, "LICENSE");
});
