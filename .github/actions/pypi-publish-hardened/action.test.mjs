import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const prepare = readFileSync(new URL("./action.yml", import.meta.url), "utf8");
const verify = readFileSync(new URL("./verify/action.yml", import.meta.url), "utf8");
const validator = readFileSync(new URL("./validate_wheels.py", import.meta.url), "utf8");
const registryVerifier = readFileSync(
  new URL("./verify_registry.py", import.meta.url),
  "utf8",
);

test("PyPI guards contain no publisher or repository checkout", () => {
  assert.match(prepare, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(prepare + verify, /gh-action-pypi-publish|actions\/checkout/);
  assert.match(prepare, /python3 "\$\{VERIFIER_PATH\}" --allow-missing/);
  assert.match(verify, /python3 "\$\{VERIFIER_PATH\}"/);
});

test("PyPI recovery and completion compare exact registry digests", () => {
  assert.match(registryVerifier, /hashlib\.sha256/);
  assert.match(registryVerifier, /entry\["digests"\]\["sha256"\]/);
  assert.match(registryVerifier, /published != digest/);
  assert.match(registryVerifier, /attempts = 1 if allow_missing else 12/);
});

test("wheel validation binds artifact, filename, metadata, and tag identities", () => {
  for (const invariant of [
    "actual_artifacts != expected_artifacts",
    "len(entries) != 1 or len(wheels) != 1",
    "names.count(metadata_name) != 1 or names.count(wheel_name) != 1",
    "contains metadata outside",
    "metadata_info.file_size > MAX_METADATA_BYTES",
    "len(actual_tag_list) != len(expected_tags) or actual_tags != expected_tags",
    "not path.is_symlink()",
    "artifact.is_symlink()",
  ]) {
    assert.match(
      validator,
      new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});
