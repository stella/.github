import { readFileSync } from "node:fs";
import { YAML } from "bun";

type JsonObject = Record<string, unknown>;

const SHA = /^[0-9a-f]{40}$/;
const RELEASE_SECRETS = new Set([
  "CHANGELOG_APP_ID",
  "CHANGELOG_APP_PRIVATE_KEY",
  "RELEASE_APP_ID",
  "RELEASE_APP_PRIVATE_KEY",
]);
const DOWNLOAD_ARTIFACT_USE =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const ATTEST_USE = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";

const fail = (message: string): never => {
  throw new Error(message);
};

const object = (value: unknown, label: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a mapping`);
  }
  return value as JsonObject;
};

const permissionMap = (value: unknown, label: string): JsonObject => {
  if (value === undefined) {
    return {};
  }
  if (typeof value === "string") {
    fail(`${label} must be an explicit permission mapping, not ${value}`);
  }
  return object(value, label);
};

const exactPermissions = (value: unknown, expected: JsonObject, label: string) => {
  const actual = permissionMap(value, label);
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    fail(`${label} must equal ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`);
  }
};

const hasWritePermission = (permissions: JsonObject) =>
  Object.values(permissions).some((value) => value === "write");

const assertPinnedUses = (uses: string, label: string) => {
  if (uses.startsWith("./")) {
    return;
  }
  const separator = uses.lastIndexOf("@");
  if (separator < 0 || !SHA.test(uses.slice(separator + 1))) {
    fail(`${label} must use an immutable 40-character commit SHA: ${uses}`);
  }
};

const walkUses = (value: unknown, path = "workflow") => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkUses(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "uses" && typeof entry === "string") {
      assertPinnedUses(entry, `${path}.uses`);
    }
    walkUses(entry, `${path}.${key}`);
  }
};

const walkSecretReferences = (
  value: unknown,
  path = "workflow",
  allowedPaths = new Set<string>(),
) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkSecretReferences(entry, `${path}[${index}]`, allowedPaths),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walkSecretReferences(entry, `${path}.${key}`, allowedPaths);
    }
    return;
  }
  if (typeof value !== "string" || !/\$\{\{[\s\S]*\bsecrets\b/i.test(value)) {
    return;
  }
  const expected = path.split(".").at(-1);
  if (
    !expected ||
    !allowedPaths.has(path) ||
    !RELEASE_SECRETS.has(expected) ||
    value !== `\${{ secrets.${expected} }}`
  ) {
    fail(`${path} contains a secret reference outside an approved finalizer mapping`);
  }
};

const expectedSharedUse = (path: string, ref: string) =>
  `stella/.github/.github/${path}@${ref}`;

const rejectUnexpectedKeys = (value: JsonObject, allowed: Set<string>, label: string) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains unsupported key ${key}`);
    }
  }
};

const requireKeys = (value: JsonObject, required: Set<string>, label: string) => {
  for (const key of required) {
    if (!(key in value)) {
      fail(`${label} is missing required key ${key}`);
    }
  }
};

const nonEmptyString = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
};

const staticString = (value: unknown, label: string) => {
  const result = nonEmptyString(value, label);
  if (result.includes("${{")) {
    fail(`${label} must be static`);
  }
  return result;
};

const validateRepositoryPath = (value: unknown, label: string) => {
  const path = staticString(value, label);
  if (path.startsWith("/") || path.split("/").includes("..")) {
    fail(`${label} must be repository-relative and must not escape the repository`);
  }
};

const validatePackageFiles = (value: unknown, label: string) => {
  const paths = nonEmptyString(value, label)
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    fail(`${label} must contain unique repository-relative package manifests`);
  }
  paths.forEach((path, index) => {
    validateRepositoryPath(path, `${label}[${index}]`);
    if (!path.endsWith("package.json")) {
      fail(`${label}[${index}] must be a package.json path`);
    }
  });
};

const validateArtifactPattern = (value: unknown, label: string) => {
  const pattern = staticString(value, label);
  if (pattern.includes("/") || pattern.includes("..")) {
    fail(`${label} must be an artifact-name pattern, not a path`);
  }
};

const validateMainOnlyCondition = (value: unknown, label: string) => {
  const condition = nonEmptyString(value, label).trim();
  const prefix = "github.ref == 'refs/heads/main' && (";
  if (!condition.startsWith(prefix) || !condition.endsWith(")")) {
    fail(`${label} must wrap the complete publisher condition in a main-ref guard`);
  }

  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = prefix.length; index < condition.length; index += 1) {
    const character = condition[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index !== condition.length - 1) {
        fail(`${label} must keep the main-ref guard outside the complete condition`);
      }
      if (depth < 0) {
        fail(`${label} contains unbalanced parentheses`);
      }
    }
  }
  if (depth !== 0 || quote !== null) {
    fail(`${label} contains an unbalanced guarded condition`);
  }
};

const validateOptionalBoolean = (value: unknown, label: string) => {
  if (typeof value === "boolean") {
    return;
  }
  const expression = nonEmptyString(value, label);
  if (!/^\$\{\{[\s\S]+\}\}$/.test(expression)) {
    fail(`${label} must be a boolean or one GitHub expression`);
  }
};

const validateSecretPairs = (secrets: JsonObject, label: string) => {
  for (const prefix of ["RELEASE_APP", "CHANGELOG_APP"]) {
    const hasId = `${prefix}_ID` in secrets;
    const hasKey = `${prefix}_PRIVATE_KEY` in secrets;
    if (hasId !== hasKey) {
      fail(`${label} must map both ${prefix} credential fields or neither`);
    }
  }
};

const REUSABLE_JOB_KEYS = new Set(["name", "needs", "if", "uses", "with", "permissions", "secrets"]);
const STEP_JOB_KEYS = new Set([
  "name",
  "needs",
  "if",
  "runs-on",
  "environment",
  "timeout-minutes",
  "permissions",
  "steps",
]);
const ACTION_STEP_KEYS = new Set(["name", "id", "if", "uses", "with"]);
const WORKFLOW_KEYS = new Set(["name", "on", "concurrency", "permissions", "jobs"]);

const validateTriggers = (value: unknown) => {
  const triggers = object(value, "workflow.on");
  for (const trigger of Object.keys(triggers)) {
    if (trigger !== "push" && trigger !== "workflow_dispatch") {
      fail(`workflow.on contains unsupported release trigger ${trigger}`);
    }
  }
  if (!("workflow_dispatch" in triggers)) {
    fail("workflow.on must include workflow_dispatch");
  }
  if ("push" in triggers) {
    const push = object(triggers.push, "workflow.on.push");
    rejectUnexpectedKeys(push, new Set(["branches", "paths"]), "workflow.on.push");
    const branches = push.branches;
    const paths = push.paths;
    if (!Array.isArray(branches) || branches.length !== 1 || branches[0] !== "main") {
      fail("workflow.on.push.branches must be exactly [main]");
    }
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((path) => typeof path !== "string" || path.length === 0 || path.includes("${{"))
    ) {
      fail("workflow.on.push.paths must contain explicit repository paths");
    }
  }
};

const validateFinalizer = (job: JsonObject, ref: string, label: string) => {
  rejectUnexpectedKeys(job, REUSABLE_JOB_KEYS, label);
  if (job.uses !== expectedSharedUse("workflows/npm-version-finalize.yml", ref)) {
    fail(`${label} must call the immutable shared npm finalizer`);
  }
  exactPermissions(
    job.permissions,
    { contents: "write", "id-token": "write" },
    `${label}.permissions`,
  );
  const inputs = object(job.with, `${label}.with`);
  rejectUnexpectedKeys(
    inputs,
    new Set([
      "version-file",
      "package-files",
      "artifact-pattern",
      "publish-to-npm",
      "update-changelog",
    ]),
    `${label}.with`,
  );
  requireKeys(inputs, new Set(["package-files"]), `${label}.with`);
  validatePackageFiles(inputs["package-files"], `${label}.with.package-files`);
  if ("version-file" in inputs) {
    validateRepositoryPath(inputs["version-file"], `${label}.with.version-file`);
  }
  if ("artifact-pattern" in inputs) {
    validateArtifactPattern(inputs["artifact-pattern"], `${label}.with.artifact-pattern`);
  }
  for (const key of ["publish-to-npm", "update-changelog"]) {
    if (key in inputs) {
      validateOptionalBoolean(inputs[key], `${label}.with.${key}`);
    }
  }
  const secrets = object(job.secrets ?? {}, `${label}.secrets`);
  for (const [name, expression] of Object.entries(secrets)) {
    if (!RELEASE_SECRETS.has(name) || expression !== `\${{ secrets.${name} }}`) {
      fail(`${label}.secrets contains an unsupported mapping for ${name}`);
    }
  }
  validateSecretPairs(secrets, `${label}.secrets`);
};

const validateCratesPublisher = (job: JsonObject, ref: string, label: string) => {
  rejectUnexpectedKeys(job, REUSABLE_JOB_KEYS, label);
  if (job.uses !== expectedSharedUse("workflows/crates-io-publish.yml", ref)) {
    fail(`${label} must call the immutable shared crates.io publisher`);
  }
  exactPermissions(
    job.permissions,
    { contents: "read", attestations: "write", "id-token": "write" },
    `${label}.permissions`,
  );
  if ("secrets" in job) {
    fail(`${label} must not receive secrets`);
  }
  const inputs = object(job.with, `${label}.with`);
  rejectUnexpectedKeys(
    inputs,
    new Set(["crate-name", "manifest-path", "version-file", "rust-toolchain", "environment"]),
    `${label}.with`,
  );
  requireKeys(inputs, new Set(["crate-name", "manifest-path"]), `${label}.with`);
  const crateName = staticString(inputs["crate-name"], `${label}.with.crate-name`);
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(crateName)) {
    fail(`${label}.with.crate-name is not a valid static crate name`);
  }
  validateRepositoryPath(inputs["manifest-path"], `${label}.with.manifest-path`);
  if ("version-file" in inputs) {
    validateRepositoryPath(inputs["version-file"], `${label}.with.version-file`);
  }
  if ("rust-toolchain" in inputs) {
    const toolchain = staticString(inputs["rust-toolchain"], `${label}.with.rust-toolchain`);
    if (!/^(?:stable|[0-9]+\.[0-9]+(?:\.[0-9]+)?)$/.test(toolchain)) {
      fail(`${label}.with.rust-toolchain must be stable or a numeric Rust release`);
    }
  }
  if ("environment" in inputs && inputs.environment !== "crates-io") {
    fail(`${label}.with.environment must be crates-io`);
  }
};

const validateNpmArtifactPublisher = (job: JsonObject, ref: string, label: string) => {
  rejectUnexpectedKeys(job, REUSABLE_JOB_KEYS, label);
  if (job.uses !== expectedSharedUse("workflows/npm-artifact-publish.yml", ref)) {
    fail(`${label} must call the immutable shared npm artifact publisher`);
  }
  exactPermissions(
    job.permissions,
    { contents: "read", "id-token": "write" },
    `${label}.permissions`,
  );
  if ("secrets" in job) {
    fail(`${label} must not receive secrets`);
  }
  const inputs = object(job.with, `${label}.with`);
  rejectUnexpectedKeys(
    inputs,
    new Set(["artifact-name", "package-name", "version", "dist-tag"]),
    `${label}.with`,
  );
  requireKeys(
    inputs,
    new Set(["artifact-name", "package-name", "version"]),
    `${label}.with`,
  );
  validateArtifactPattern(inputs["artifact-name"], `${label}.with.artifact-name`);
  const packageName = staticString(inputs["package-name"], `${label}.with.package-name`);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    fail(`${label}.with.package-name is not a valid static npm package name`);
  }
  nonEmptyString(inputs.version, `${label}.with.version`);
  if ("dist-tag" in inputs) {
    nonEmptyString(inputs["dist-tag"], `${label}.with.dist-tag`);
  }
};

const validateIndependentNpmPublisher = (job: JsonObject, ref: string, label: string) => {
  rejectUnexpectedKeys(job, REUSABLE_JOB_KEYS, label);
  if (job.uses !== expectedSharedUse("workflows/npm-independent-release.yml", ref)) {
    fail(`${label} must call the immutable shared independent npm publisher`);
  }
  exactPermissions(
    job.permissions,
    { actions: "read", contents: "write", "id-token": "write" },
    `${label}.permissions`,
  );
  const secrets = object(job.secrets ?? {}, `${label}.secrets`);
  for (const [name, expression] of Object.entries(secrets)) {
    if (
      (name !== "RELEASE_APP_ID" && name !== "RELEASE_APP_PRIVATE_KEY") ||
      expression !== `\${{ secrets.${name} }}`
    ) {
      fail(`${label}.secrets contains an unsupported mapping for ${name}`);
    }
  }
  validateSecretPairs(secrets, `${label}.secrets`);
  const inputs = object(job.with, `${label}.with`);
  rejectUnexpectedKeys(
    inputs,
    new Set([
      "package-files",
      "artifact-pattern",
      "artifact-run-id",
      "dist-tag",
      "github-latest-policy",
      "github-latest-package",
      "source-ref",
    ]),
    `${label}.with`,
  );
  requireKeys(inputs, new Set(["package-files"]), `${label}.with`);
  validatePackageFiles(inputs["package-files"], `${label}.with.package-files`);
  if ("artifact-pattern" in inputs) {
    validateArtifactPattern(inputs["artifact-pattern"], `${label}.with.artifact-pattern`);
  }
  for (const key of [
    "artifact-run-id",
    "dist-tag",
    "github-latest-policy",
    "github-latest-package",
    "source-ref",
  ]) {
    if (key in inputs) {
      nonEmptyString(inputs[key], `${label}.with.${key}`);
    }
  }
};

const validatePyPiPublisher = (job: JsonObject, ref: string, label: string) => {
  rejectUnexpectedKeys(job, STEP_JOB_KEYS, label);
  exactPermissions(job.permissions, { "id-token": "write" }, `${label}.permissions`);
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length !== 1) {
    fail(`${label} must contain exactly one privileged publisher step`);
  }
  const step = object(steps[0], `${label}.steps[0]`);
  rejectUnexpectedKeys(step, ACTION_STEP_KEYS, `${label}.steps[0]`);
  if (step.uses !== expectedSharedUse("actions/pypi-publish-hardened", ref)) {
    fail(`${label} must use the immutable shared PyPI publisher`);
  }
  if ("if" in step || "id" in step) {
    fail(`${label}.steps[0] must not be conditional or expose action outputs`);
  }
  const inputs = object(step.with, `${label}.steps[0].with`);
  rejectUnexpectedKeys(
    inputs,
    new Set([
      "artifact-pattern",
      "expected-version",
      "project-name",
      "distribution-name",
      "wheel-contract",
      "skip-existing",
    ]),
    `${label}.steps[0].with`,
  );
  requireKeys(
    inputs,
    new Set(["expected-version", "project-name", "distribution-name", "wheel-contract"]),
    `${label}.steps[0].with`,
  );
  nonEmptyString(inputs["expected-version"], `${label}.steps[0].with.expected-version`);
  const projectName = staticString(
    inputs["project-name"],
    `${label}.steps[0].with.project-name`,
  );
  const distributionName = staticString(
    inputs["distribution-name"],
    `${label}.steps[0].with.distribution-name`,
  );
  if (!/^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/.test(projectName)) {
    fail(`${label}.steps[0].with.project-name is not a valid static Python project name`);
  }
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(distributionName)) {
    fail(`${label}.steps[0].with.distribution-name must be wheel-normalized`);
  }
  if ("artifact-pattern" in inputs) {
    validateArtifactPattern(
      inputs["artifact-pattern"],
      `${label}.steps[0].with.artifact-pattern`,
    );
  }
  if (
    "skip-existing" in inputs &&
    inputs["skip-existing"] !== "true" &&
    inputs["skip-existing"] !== true
  ) {
    fail(`${label}.steps[0].with.skip-existing must remain true`);
  }
  let contract: unknown;
  try {
    contract = JSON.parse(staticString(inputs["wheel-contract"], `${label}.steps[0].with.wheel-contract`));
  } catch {
    fail(`${label}.steps[0].with.wheel-contract must be valid static JSON`);
  }
  const contractMap = object(contract, `${label}.steps[0].with.wheel-contract`);
  if (Object.keys(contractMap).length === 0) {
    fail(`${label}.steps[0].with.wheel-contract must not be empty`);
  }
  for (const [artifactName, platformTags] of Object.entries(contractMap)) {
    validateArtifactPattern(artifactName, `${label}.steps[0].with.wheel-contract artifact`);
    if (
      !Array.isArray(platformTags) ||
      platformTags.length === 0 ||
      new Set(platformTags).size !== platformTags.length ||
      platformTags.some(
        (tag) => typeof tag !== "string" || !/^[A-Za-z0-9]+(?:[_.][A-Za-z0-9]+)*$/.test(tag),
      )
    ) {
      fail(`${label}.steps[0].with.wheel-contract.${artifactName} has invalid platform tags`);
    }
  }
};

const validateAttestation = (job: JsonObject, label: string) => {
  rejectUnexpectedKeys(job, STEP_JOB_KEYS, label);
  exactPermissions(
    job.permissions,
    { contents: "read", attestations: "write", "id-token": "write" },
    `${label}.permissions`,
  );
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    fail(`${label} must contain attestation steps`);
  }
  const actionUses = steps.map((rawStep, index) =>
    object(rawStep, `${label}.steps[${index}]`).uses,
  );
  if (
    actionUses[0] !== DOWNLOAD_ARTIFACT_USE ||
    actionUses.filter((uses) => uses === DOWNLOAD_ARTIFACT_USE).length !== 1 ||
    !actionUses.slice(1).every((uses) => uses === ATTEST_USE)
  ) {
    fail(`${label} must download release-artifacts once before every attestation`);
  }
  for (const [index, rawStep] of steps.entries()) {
    const step = object(rawStep, `${label}.steps[${index}]`);
    rejectUnexpectedKeys(step, ACTION_STEP_KEYS, `${label}.steps[${index}]`);
    const uses = step.uses;
    if (uses !== DOWNLOAD_ARTIFACT_USE && uses !== ATTEST_USE) {
      fail(`${label} may only download and attest prepared artifacts`);
    }
    const inputs = object(step.with, `${label}.steps[${index}].with`);
    if (uses === DOWNLOAD_ARTIFACT_USE) {
      if ("if" in step || "id" in step) {
        fail(`${label}.steps[${index}] must always download the local release artifact`);
      }
      rejectUnexpectedKeys(inputs, new Set(["name", "path"]), `${label}.steps[${index}].with`);
      requireKeys(inputs, new Set(["name", "path"]), `${label}.steps[${index}].with`);
      if (inputs.name !== "release-artifacts" || inputs.path !== "release-artifacts") {
        fail(`${label}.steps[${index}] must download release-artifacts locally`);
      }
      continue;
    }
    rejectUnexpectedKeys(
      inputs,
      new Set(["subject-path", "sbom-path"]),
      `${label}.steps[${index}].with`,
    );
    requireKeys(inputs, new Set(["subject-path"]), `${label}.steps[${index}].with`);
    const subjectPath = staticString(
      inputs["subject-path"],
      `${label}.steps[${index}].with.subject-path`,
    );
    if (!subjectPath.startsWith("release-artifacts/") || subjectPath.includes("..")) {
      fail(`${label}.steps[${index}].with.subject-path must stay under release-artifacts`);
    }
    if ("sbom-path" in inputs) {
      const sbomPath = staticString(
        inputs["sbom-path"],
        `${label}.steps[${index}].with.sbom-path`,
      );
      if (!sbomPath.startsWith("release-artifacts/") || sbomPath.includes("..")) {
        fail(`${label}.steps[${index}].with.sbom-path must stay under release-artifacts`);
      }
    }
  }
};

export const validateReleaseWorkflow = (source: string, expectedRef: string) => {
  if (!SHA.test(expectedRef)) {
    fail("expected shared ref must be an immutable 40-character commit SHA");
  }
  const workflow = object(YAML.parse(source), "workflow");
  rejectUnexpectedKeys(workflow, WORKFLOW_KEYS, "workflow");
  validateTriggers(workflow.on);
  const workflowPermissions = permissionMap(workflow.permissions, "workflow.permissions");
  if (hasWritePermission(workflowPermissions)) {
    fail("workflow-level permissions must not grant write access");
  }
  exactPermissions(workflow.permissions, { contents: "read" }, "workflow.permissions");
  walkUses(workflow);
  for (const [key, value] of Object.entries(workflow)) {
    if (key !== "jobs") {
      walkSecretReferences(value, `workflow.${key}`);
    }
  }

  const jobs = object(workflow.jobs, "workflow.jobs");
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const label = `jobs.${jobName}`;
    const job = object(rawJob, label);
    if (job.secrets === "inherit") {
      fail(`${label} must not inherit secrets`);
    }
    const permissions = permissionMap(job.permissions, `${label}.permissions`);
    const inheritedWrite = Object.keys(permissions).length === 0 && hasWritePermission(workflowPermissions);
    if (!hasWritePermission(permissions) && !inheritedWrite) {
      walkSecretReferences(job, label);
      continue;
    }

    validateMainOnlyCondition(job.if, `${label}.if`);

    if (typeof job.uses === "string") {
      const allowedSecretPaths = new Set<string>();
      if (job.uses.includes("npm-version-finalize.yml")) {
        validateFinalizer(job, expectedRef, label);
        for (const name of Object.keys(object(job.secrets ?? {}, `${label}.secrets`))) {
          allowedSecretPaths.add(`${label}.secrets.${name}`);
        }
      } else if (job.uses.includes("npm-independent-release.yml")) {
        validateIndependentNpmPublisher(job, expectedRef, label);
        for (const name of Object.keys(object(job.secrets ?? {}, `${label}.secrets`))) {
          allowedSecretPaths.add(`${label}.secrets.${name}`);
        }
      } else if (job.uses.includes("npm-artifact-publish.yml")) {
        validateNpmArtifactPublisher(job, expectedRef, label);
      } else if (job.uses.includes("crates-io-publish.yml")) {
        validateCratesPublisher(job, expectedRef, label);
      } else {
        fail(`${label} calls an unsupported privileged reusable workflow`);
      }
      walkSecretReferences(job, label, allowedSecretPaths);
      continue;
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    const uses = steps
      .map((step) => (step && typeof step === "object" ? (step as JsonObject).uses : undefined))
      .filter((value): value is string => typeof value === "string");
    if (uses.some((use) => use.includes("pypi-publish-hardened"))) {
      validatePyPiPublisher(job, expectedRef, label);
    } else if (uses.some((use) => use.startsWith("actions/attest@"))) {
      validateAttestation(job, label);
    } else {
      fail(`${label} has write permission but is not an approved publisher or attestor`);
    }
    walkSecretReferences(job, label);
  }
};

if (import.meta.main) {
  const [workflowPath, expectedRef] = process.argv.slice(2);
  if (!(workflowPath && expectedRef)) {
    fail("usage: check.ts <release-workflow> <expected-shared-ref>");
  }
  validateReleaseWorkflow(readFileSync(workflowPath, "utf8"), expectedRef);
  console.log(`Release privilege boundaries validated: ${workflowPath}`);
}
