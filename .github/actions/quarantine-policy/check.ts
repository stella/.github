import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  checkQuarantinePolicy as checkSharedQuarantinePolicy,
  pruneExpiredExcludes as pruneSharedExpiredExcludes,
  readParsedExcludes as readSharedParsedExcludes,
} from "../../../../.quarantine-tooling/packages/oxlint-config/src/quarantine-policy-core";
export {
  EXACT_UTC_TIMESTAMP,
  exactTimestamp,
  NPM_REGISTRY,
  REQUIRED_RELEASE_AGE_SECONDS,
} from "../../../../.quarantine-tooling/packages/oxlint-config/src/quarantine-policy-core";

const BUNFIG = "bunfig.toml";
const LOCKFILE = "bun.lock";
const SHARED_WORKFLOW_PREFIX = "stella/.github/.github/workflows/";
const HOURLY_CRON = /^(?:[0-9]|[1-5][0-9]) \* \* \* \*$/u;
const fail = (message: string): never => {
  throw new Error(message);
};

export const pathEntryExists = (entryPath: string): boolean =>
  lstatSync(entryPath, { throwIfNoEntry: false }) !== undefined;

export const readParsedExcludes = (bunfig: string): string[] =>
  readSharedParsedExcludes(bunfig, Bun.TOML.parse);

export const checkQuarantinePolicy = (options: Omit<Parameters<typeof checkSharedQuarantinePolicy>[0], "parseToml">) =>
  checkSharedQuarantinePolicy({ ...options, parseToml: Bun.TOML.parse });

export const pruneExpiredExcludes = (options: Omit<Parameters<typeof pruneSharedExpiredExcludes>[0], "parseToml">) =>
  pruneSharedExpiredExcludes({ ...options, parseToml: Bun.TOML.parse });

export const validateCallerWorkflowRefs = ({
  expectedRef,
  expectedRepository,
  policyWorkflow,
  pruneWorkflow,
}: {
  expectedRef: string;
  expectedRepository: string;
  policyWorkflow: string;
  pruneWorkflow: string;
}): string[] => {
  if (!/^[0-9a-f]{40}$/u.test(expectedRef)) {
    return ["the shared quarantine policy ref must be a full commit SHA"];
  }
  if (!/^stella\/[a-z0-9._-]+$/u.test(expectedRepository)) {
    return ["the quarantine caller repository must be an explicit stella repository"];
  }
  const expected = [
    ["quarantine-policy.yml", policyWorkflow, ["merge_group", "pull_request"]],
    ["quarantine-prune.yml", pruneWorkflow, ["schedule"]],
  ] as const;
  return expected.flatMap(([name, workflow, expectedTriggers]) => {
    const target = `${SHARED_WORKFLOW_PREFIX}${name}@${expectedRef}`;
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(workflow);
    } catch {
      return [`.github/workflows/${name} must be valid YAML`];
    }
    if (typeof parsed !== "object" || parsed === null) {
      return [`.github/workflows/${name} must be a YAML mapping`];
    }
    const workflowKeys = Object.keys(parsed).sort();
    if (workflowKeys.join(",") !== "jobs,name,on,permissions") {
      return [`.github/workflows/${name} must contain only name, triggers, permissions, and jobs`];
    }
    if (!("on" in parsed) || typeof parsed.on !== "object" || parsed.on === null) {
      return [`.github/workflows/${name} must declare required triggers`];
    }
    const triggers = Object.keys(parsed.on).sort();
    if (triggers.join(",") !== [...expectedTriggers].sort().join(",")) {
      return [`.github/workflows/${name} must declare only ${expectedTriggers.join(" and ")}`];
    }
    if (name === "quarantine-policy.yml") {
      const invalidTrigger = Object.values(parsed.on).some(
        (value) =>
          value !== null &&
          (typeof value !== "object" || Object.keys(value).length !== 0),
      );
      if (invalidTrigger) {
        return [`.github/workflows/${name} must not filter enforcement triggers`];
      }
    } else {
      const schedule = parsed.on.schedule;
      if (
        !Array.isArray(schedule) ||
        schedule.length !== 1 ||
        typeof schedule[0] !== "object" ||
        schedule[0] === null ||
        !("cron" in schedule[0]) ||
        typeof schedule[0].cron !== "string" ||
        Object.keys(schedule[0]).length !== 1 ||
        !HOURLY_CRON.test(schedule[0].cron)
      ) {
        return [`.github/workflows/${name} must declare one hourly schedule`];
      }
    }
    if (!("permissions" in parsed) || typeof parsed.permissions !== "object" || parsed.permissions === null) {
      return [`.github/workflows/${name} must grant only contents read`];
    }
    const workflowPermissions = Object.entries(parsed.permissions);
    if (
      workflowPermissions.length !== 1 ||
      workflowPermissions[0]?.[0] !== "contents" ||
      workflowPermissions[0]?.[1] !== "read"
    ) {
      return [`.github/workflows/${name} must grant only contents read`];
    }
    if (!("jobs" in parsed)) {
      return [`.github/workflows/${name} must declare one caller job`];
    }
    const jobs = parsed.jobs;
    if (typeof jobs !== "object" || jobs === null || Object.keys(jobs).length !== 1) {
      return [`.github/workflows/${name} must declare one caller job`];
    }
    const job = Object.values(jobs).at(0);
    if (typeof job !== "object" || job === null || !("uses" in job) || job.uses !== target) {
      return [`.github/workflows/${name} must use ${target} exactly once`];
    }
    const expectedJobKeys = name === "quarantine-policy.yml"
      ? ["if", "name", "permissions", "uses"]
      : ["if", "name", "permissions", "secrets", "uses"];
    if (Object.keys(job).sort().join(",") !== expectedJobKeys.join(",")) {
      return [`.github/workflows/${name} must contain only the canonical caller job fields`];
    }
    const expectedCondition = `github.repository == '${expectedRepository}'`;
    if (!("if" in job) || job.if !== expectedCondition) {
      return [`.github/workflows/${name} must use only the exact repository guard ${expectedCondition}`];
    }
    if (!("permissions" in job) || typeof job.permissions !== "object" || job.permissions === null) {
      return [`.github/workflows/${name} caller job must grant only contents read`];
    }
    const jobPermissions = Object.entries(job.permissions);
    if (
      jobPermissions.length !== 1 ||
      jobPermissions[0]?.[0] !== "contents" ||
      jobPermissions[0]?.[1] !== "read"
    ) {
      return [`.github/workflows/${name} caller job must grant only contents read`];
    }
    if (name === "quarantine-prune.yml") {
      if (!("secrets" in job) || typeof job.secrets !== "object" || job.secrets === null) {
        return [`.github/workflows/${name} must pass only the quarantine App secrets`];
      }
      const secrets = Object.entries(job.secrets).sort(([left], [right]) => left.localeCompare(right));
      const expectedSecrets = [
        ["CHANGELOG_APP_ID", "${{ secrets.CHANGELOG_APP_ID }}"],
        ["CHANGELOG_APP_PRIVATE_KEY", "${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}"],
      ];
      if (JSON.stringify(secrets) !== JSON.stringify(expectedSecrets)) {
        return [`.github/workflows/${name} must pass only the quarantine App secrets`];
      }
    }
    return [];
  });
};

const run = () => {
  const root = process.cwd();
  const bunfigPath = path.join(root, BUNFIG);
  const bunfig = readFileSync(bunfigPath, "utf8");
  if (process.argv.includes("--prune")) {
    const result = pruneExpiredExcludes({ bunfig });
    if (result.pruned.length > 0) writeFileSync(bunfigPath, result.bunfig);
    console.log(`${BUNFIG}: removed ${result.pruned.length} expired quarantine exclude(s)`);
    return;
  }

  const result = checkQuarantinePolicy({
    bunfig,
    lockfile: readFileSync(path.join(root, LOCKFILE), "utf8"),
    npmrcPresent: pathEntryExists(path.join(root, ".npmrc")),
  });
  const expectedRef = process.argv[2];
  if (expectedRef !== undefined) {
    const expectedRepository = process.argv[3];
    if (expectedRepository === undefined) {
      fail("the caller repository is required with the shared policy ref");
    }
    result.errors.push(
      ...validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository,
        policyWorkflow: readFileSync(
          path.join(root, ".github/workflows/quarantine-policy.yml"),
          "utf8",
        ),
        pruneWorkflow: readFileSync(
          path.join(root, ".github/workflows/quarantine-prune.yml"),
          "utf8",
        ),
      }),
    );
  }
  if (result.warnings.length > 0) console.warn(result.warnings.join("\n"));
  if (result.errors.length > 0) fail(result.errors.join("\n\n"));
  console.log(`${BUNFIG}: package quarantine policy validated`);
};

if (import.meta.main) run();
