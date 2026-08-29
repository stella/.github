import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const action = readFileSync(new URL("./action.yml", import.meta.url), "utf8");
const validator = readFileSync(new URL("./validate_wheels.py", import.meta.url), "utf8");
const verifier = readFileSync(new URL("./verify_registry.py", import.meta.url), "utf8");

test("PyPI publishing consumes only downloaded, validated artifacts", () => {
  assert.match(action, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(action, /pypa\/gh-action-pypi-publish@[0-9a-f]{40}/);
  assert.doesNotMatch(action, /actions\/checkout|(?:npm|bun|pip|uv) install/);
  assert.match(action, /skip-existing: \$\{\{ inputs\.skip-existing \}\}/);
  assert.equal((action.match(/verify_registry\.py/g) ?? []).length, 2);
});

test("PyPI recovery and completion compare exact registry digests", () => {
  assert.match(verifier, /hashlib\.sha256/);
  assert.match(verifier, /entry\["digests"\]\["sha256"\]/);
  assert.match(verifier, /published != digest/);
  assert.match(verifier, /attempts = 1 if allow_missing else 12/);
});

test("wheel validation binds artifact, filename, metadata, and tag identities", () => {
  for (const invariant of [
    "actual_artifacts != expected_artifacts",
    "len(entries) != 1 or len(wheels) != 1",
    "exactly one METADATA and one WHEEL",
    "metadata_info.file_size > MAX_METADATA_BYTES",
    "actual_tags != expected_tags",
    "not path.is_symlink()",
    "artifact.is_symlink()",
  ]) {
    assert.match(validator, new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
