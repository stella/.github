import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("./pypi-publish.yml", import.meta.url), "utf8");
const validator = readFileSync(
  new URL("../actions/pypi-publish-hardened/validate_wheels.py", import.meta.url),
  "utf8",
);
const verifier = readFileSync(
  new URL("../actions/pypi-publish-hardened/verify_registry.py", import.meta.url),
  "utf8",
);

test("PyPI publication runs the Docker publisher as a workflow step", () => {
  assert.match(
    workflow,
    /uses: pypa\/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33/,
  );
  assert.doesNotMatch(workflow, /uses: .*pypi-publish-hardened/);
});

test("PyPI publication loads tooling from the called workflow commit", () => {
  assert.match(workflow, /repository: \$\{\{ job\.workflow_repository \}\}/);
  assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
});

test("PyPI recovery and completion are bound to exact registry bytes", () => {
  assert.match(workflow, /verify_registry\.py/);
  assert.match(workflow, /python3 "\$\{VERIFIER_PATH\}" --allow-missing/);
  assert.match(workflow, /skip-existing: true/);
  assert.match(
    workflow,
    /Verify published PyPI files match exact bytes[\s\S]*python3 "\$\{VERIFIER_PATH\}"/,
  );
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
    "names.count(metadata_name) != 1 or names.count(wheel_name) != 1",
    "contains metadata outside",
    "metadata_info.file_size > MAX_METADATA_BYTES",
    "len(actual_tag_list) != len(expected_tags) or actual_tags != expected_tags",
    "not path.is_symlink()",
    "artifact.is_symlink()",
  ]) {
    assert.match(validator, new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
