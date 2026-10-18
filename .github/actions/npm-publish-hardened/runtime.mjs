import { spawnSync } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readNpmState } from "../npm-visibility/registry.mjs";
import {
  resolveNpmVisibilityTimeoutMinutes,
  waitForNpmPackages,
} from "../npm-visibility/wait.mjs";

const publishScript = fileURLToPath(new URL("./publish.sh", import.meta.url));
const fail = (message) => {
  throw new Error(message);
};

export const validatePublishPlan = ({
  planText, tarball, tarballs, expectedName, expectedVersion,
}) => {
  if (tarball || expectedName || expectedVersion) {
    fail("publish-plan requires tarballs and cannot be combined with tarball or expected-name/expected-version.");
  }
  const paths = (tarballs ?? "").split(/\r?\n/).filter(Boolean);
  const plan = JSON.parse(planText);
  if (!Array.isArray(plan) || plan.length === 0 || plan.length !== paths.length) {
    fail("publish-plan must contain exactly one entry per ordered tarball.");
  }
  const names = new Set();
  const seenPaths = new Set();
  for (const [index, entry] of plan.entries()) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.name !== "string" || !entry.name || /[\s\0]/.test(entry.name) ||
      typeof entry.version !== "string" || !entry.version || /[\s\0]/.test(entry.version) ||
      typeof entry.path !== "string" || /[\r\n\0]/.test(entry.path) || entry.path !== paths[index] ||
      !Array.isArray(entry.dependencies) || entry.dependencies.some((name) => typeof name !== "string")
    ) {
      fail(`Invalid publish-plan entry at index ${index}; entries must match the ordered tarballs.`);
    }
    if (names.has(entry.name) || seenPaths.has(entry.path)) {
      fail(`Duplicate publish-plan package or tarball: ${entry.name}.`);
    }
    for (const dependency of entry.dependencies) {
      if (!names.has(dependency)) {
        fail(`publish-plan dependency ${dependency} must precede ${entry.name}; cycles and missing dependencies are not allowed.`);
      }
    }
    names.add(entry.name);
    seenPaths.add(entry.path);
  }
  return plan;
};

const runPublishScript = (env) => {
  const result = spawnSync("bash", ["-eo", "pipefail", publishScript], {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`Hardened npm publisher exited with status ${result.status ?? result.signal}.`);
};

const writeActionOutput = (name, values) => {
  if (!process.env.GITHUB_OUTPUT) return;
  // Names have already been checked for whitespace/control characters.
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${JSON.stringify(values)}\n`);
};

export const publishReleaseEntries = async ({
  env = process.env,
  publishTarball = runPublishScript,
  checkTarball = (path) => {
    if (!statSync(path).isFile()) fail(`Tarball is not a file: ${path}.`);
  },
  readRegistryState = readNpmState,
  waitForPackages = waitForNpmPackages,
  writeOutput = writeActionOutput,
  now = Date.now,
} = {}) => {
  if (!env.PUBLISH_PLAN) {
    // Other callers retain the hardened action's singular/multi-tarball contract.
    await publishTarball(env);
    return;
  }
  const plan = validatePublishPlan({
    planText: env.PUBLISH_PLAN,
    tarball: env.TARBALL,
    tarballs: env.TARBALLS,
    expectedName: env.EXPECTED_NAME,
    expectedVersion: env.EXPECTED_VERSION,
  });
  const timeoutMinutes = resolveNpmVisibilityTimeoutMinutes(
    env.NPM_VISIBILITY_TIMEOUT_MINUTES,
  );
  for (const entry of plan) checkTarball(entry.path);
  const deadline = now() + timeoutMinutes * 60_000;
  writeOutput("skipped-dependents", []);
  for (const [index, entry] of plan.entries()) {
    try {
      if (now() >= deadline) fail("npm visibility budget exhausted before publication.");
      await publishTarball({
        ...env,
        TARBALL: entry.path,
        TARBALLS: "",
        EXPECTED_NAME: entry.name,
        EXPECTED_VERSION: entry.version,
      });
      const missing = await waitForPackages({
        packages: [{ name: entry.name, version: entry.version }],
        readNpmState: readRegistryState,
        timeoutMinutes: Math.max(0, (deadline - now()) / 60_000),
      });
      if (missing.length > 0) fail(`npm is still missing ${entry.name}@${entry.version}.`);
    } catch (error) {
      const blocked = new Set([entry.name]);
      const skipped = [];
      for (const candidate of plan.slice(index + 1)) {
        if (!candidate.dependencies.some((name) => blocked.has(name))) continue;
        blocked.add(candidate.name);
        skipped.push(candidate.name);
      }
      writeOutput("skipped-dependents", skipped);
      fail(`Failed to publish ${entry.name}@${entry.version}: ${error.message} Skipped dependents: ${skipped.join(", ") || "none"}.`);
    }
  }
};
