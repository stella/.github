import { readFileSync } from "node:fs";
import { YAML } from "bun";

type JsonObject = Record<string, unknown>;

const SHA = /^[0-9a-f]{40}$/;
const WRITE_PERMISSIONS = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
]);
const RELEASE_SECRETS = new Set([
  "CHANGELOG_APP_ID",
  "CHANGELOG_APP_PRIVATE_KEY",
  "RELEASE_APP_ID",
  "RELEASE_APP_PRIVATE_KEY",
]);

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
  Object.entries(permissions).some(
    ([name, value]) => WRITE_PERMISSIONS.has(name) && value === "write",
  );

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

const walkSecretReferences = (value: unknown, path = "workflow") => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkSecretReferences(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walkSecretReferences(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string" || !/secrets\s*(?:\.|\[)/i.test(value)) {
    return;
  }
  const match = path.match(/^workflow\.jobs\.[^.]+\.secrets\.([A-Z0-9_]+)$/);
  const expected = match?.[1];
  if (!expected || !RELEASE_SECRETS.has(expected) || value !== `\${{ secrets.${expected} }}`) {
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
    const branches = push.branches;
    const paths = push.paths;
    if (!Array.isArray(branches) || branches.length !== 1 || branches[0] !== "main") {
      fail("workflow.on.push.branches must be exactly [main]");
    }
    if (!Array.isArray(paths) || paths.length !== 1 || paths[0] !== "VERSION") {
      fail("workflow.on.push.paths must be exactly [VERSION]");
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
  const secrets = object(job.secrets ?? {}, `${label}.secrets`);
  for (const [name, expression] of Object.entries(secrets)) {
    if (!RELEASE_SECRETS.has(name) || expression !== `\${{ secrets.${name} }}`) {
      fail(`${label}.secrets contains an unsupported mapping for ${name}`);
    }
  }
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
  if ("run" in step || "env" in step) {
    fail(`${label} must not run repository-controlled code or set publisher environment values`);
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
  for (const [index, rawStep] of steps.entries()) {
    const step = object(rawStep, `${label}.steps[${index}]`);
    rejectUnexpectedKeys(step, ACTION_STEP_KEYS, `${label}.steps[${index}]`);
    if ("run" in step || "env" in step) {
      fail(`${label} must not run repository-controlled code or set environment values`);
    }
    const uses = step.uses;
    if (
      typeof uses !== "string" ||
      (!uses.startsWith("actions/download-artifact@") && !uses.startsWith("actions/attest@"))
    ) {
      fail(`${label} may only download and attest prepared artifacts`);
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
  walkSecretReferences(workflow);

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
      continue;
    }

    if (typeof job.uses === "string") {
      if (job.uses.includes("npm-version-finalize.yml")) {
        validateFinalizer(job, expectedRef, label);
      } else if (job.uses.includes("npm-artifact-publish.yml")) {
        validateNpmArtifactPublisher(job, expectedRef, label);
      } else if (job.uses.includes("crates-io-publish.yml")) {
        validateCratesPublisher(job, expectedRef, label);
      } else {
        fail(`${label} calls an unsupported privileged reusable workflow`);
      }
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
