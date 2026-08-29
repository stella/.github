import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BUNFIG = "bunfig.toml";
const LOCKFILE = "bun.lock";
const REQUIRED_RELEASE_AGE_SECONDS = 5 * 24 * 60 * 60;
const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPIRY_MARKER = "quarantine-expires:";
const EXCLUDED_SINCE_MARKER = "quarantine-excluded-since:";
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHARED_WORKFLOW_PREFIX = "stella/.github/.github/workflows/";
const REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const HOURLY_CRON = /^(?:[0-9]|[1-5][0-9]) \* \* \* \*$/u;

type BlockRange = { end: number; start: number };

const fail = (message: string): never => {
  throw new Error(message);
};

const findExcludeBlock = (bunfig: string): BlockRange | undefined => {
  const declaration = /^[\t ]*minimumReleaseAgeExcludes[\t ]*=/mu.exec(bunfig);
  if (declaration === null) {
    return undefined;
  }

  const arrayStart = bunfig.indexOf("[", declaration.index);
  if (arrayStart === -1) {
    return undefined;
  }

  let state: "basic" | "comment" | "literal" | "plain" = "plain";
  let escaped = false;
  for (let index = arrayStart; index < bunfig.length; index++) {
    const character = bunfig[index];
    if (state === "comment") {
      if (character === "\n") state = "plain";
      continue;
    }
    if (state === "basic") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') state = "plain";
      continue;
    }
    if (state === "literal") {
      if (character === "'") state = "plain";
      continue;
    }
    if (character === "#") state = "comment";
    else if (character === '"') state = "basic";
    else if (character === "'") state = "literal";
    else if (character === "]") {
      return { end: index, start: declaration.index };
    }
  }
  return undefined;
};

const exactTimestamp = (value: string): boolean => {
  const timestamp = Date.parse(value);
  return (
    EXACT_UTC_TIMESTAMP.test(value) &&
    !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
};

type Entry = {
  annotation: "excluded-since" | "expires";
  name: string;
  timestamp: string;
};

const parseEntry = (line: string): Entry | undefined => {
  const match = /^\s*"(?<name>[^"]+)"\s*,?\s*#\s*(?<marker>quarantine-expires:|quarantine-excluded-since:)\s*(?<timestamp>\S+)\s*$/u.exec(
    line,
  );
  if (match?.groups === undefined) return undefined;
  return {
    annotation:
      match.groups.marker === EXPIRY_MARKER ? "expires" : "excluded-since",
    name: match.groups.name,
    timestamp: match.groups.timestamp,
  };
};

const readParsedExcludes = (bunfig: string): string[] => {
  const parsed = Bun.TOML.parse(bunfig);
  if (!("install" in parsed) || typeof parsed.install !== "object" || parsed.install === null) {
    fail(`${BUNFIG} must contain an [install] table`);
  }
  const install = parsed.install;
  if (
    !("minimumReleaseAge" in install) ||
    install.minimumReleaseAge !== REQUIRED_RELEASE_AGE_SECONDS
  ) {
    fail(`${BUNFIG} must set minimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}`);
  }
  if (
    !("minimumReleaseAgeExcludes" in install) ||
    !Array.isArray(install.minimumReleaseAgeExcludes)
  ) {
    fail(`${BUNFIG} must declare minimumReleaseAgeExcludes as an array`);
  }
  const names = install.minimumReleaseAgeExcludes.flatMap((value) =>
    typeof value === "string" ? [value] : [],
  );
  if (names.length !== install.minimumReleaseAgeExcludes.length) {
    fail(`${BUNFIG} minimumReleaseAgeExcludes must contain only package names`);
  }
  return names;
};

const readRegistryFirstPartyPackages = (lockfile: string): Set<string> =>
  new Set(
    [...lockfile.matchAll(/"[^"\n]+":\s*\["(?<name>@stll\/[^"@]+)@(?<source>[^"]+)"/gu)].flatMap(
      (match) => {
        const name = match.groups?.name;
        const source = match.groups?.source;
        if (
          name === undefined ||
          source === undefined ||
          !REGISTRY_VERSION.test(source)
        ) {
          return [];
        }
        return [name];
      },
    ),
  );

export type CheckResult = {
  errors: string[];
  warnings: string[];
};

export const checkQuarantinePolicy = ({
  bunfig,
  lockfile,
  now = new Date(),
}: {
  bunfig: string;
  lockfile: string;
  now?: Date;
}): CheckResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  let excludes: string[];
  try {
    excludes = readParsedExcludes(bunfig);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], warnings };
  }

  const range = findExcludeBlock(bunfig);
  if (range === undefined) {
    return { errors: [`${BUNFIG} has an unterminated minimumReleaseAgeExcludes array`], warnings };
  }

  const entries = bunfig
    .slice(range.start, range.end)
    .split("\n")
    .flatMap((line) => {
      if (!/^\s*"/u.test(line)) return [];
      const entry = parseEntry(line);
      if (entry === undefined) {
        errors.push(`${BUNFIG} has an unannotated or malformed quarantine exclude: ${line.trim()}`);
        return [];
      }
      return [entry];
    });

  const declared = entries.map(({ name }) => name);
  if (new Set(declared).size !== declared.length || new Set(excludes).size !== excludes.length) {
    errors.push(`${BUNFIG} minimumReleaseAgeExcludes must not contain duplicates`);
  }
  const parsedSet = new Set(excludes);
  const declaredSet = new Set(declared);
  const unrecognized = excludes.filter((name) => !declaredSet.has(name));
  const phantom = declared.filter((name) => !parsedSet.has(name));
  if (unrecognized.length > 0 || phantom.length > 0) {
    errors.push(`${BUNFIG} must declare one annotated package per line`);
  }

  const nowMs = now.getTime();
  for (const entry of entries) {
    if (!exactTimestamp(entry.timestamp)) {
      errors.push(`${BUNFIG} quarantine exclude "${entry.name}" has an invalid UTC timestamp: ${entry.timestamp}`);
      continue;
    }
    const timestampMs = Date.parse(entry.timestamp);
    if (entry.name.startsWith("@stll/")) {
      if (entry.annotation !== "excluded-since") {
        errors.push(`${BUNFIG} first-party quarantine exclude "${entry.name}" must use ${EXCLUDED_SINCE_MARKER}`);
      } else if (timestampMs > nowMs) {
        errors.push(`${BUNFIG} first-party quarantine exclude "${entry.name}" has a future exclusion date`);
      }
      continue;
    }
    if (entry.annotation !== "expires") {
      errors.push(`${BUNFIG} third-party quarantine exclude "${entry.name}" must use ${EXPIRY_MARKER}`);
      continue;
    }
    if (nowMs >= timestampMs + NOTICE_WINDOW_MS) {
      errors.push(`${BUNFIG} temporary quarantine exclude "${entry.name}" expired at ${entry.timestamp} and is still present`);
    } else if (nowMs >= timestampMs) {
      warnings.push(`${BUNFIG} temporary quarantine exclude "${entry.name}" expired at ${entry.timestamp}; its removal PR should be merged`);
    }
  }

  const missing = [...readRegistryFirstPartyPackages(lockfile)]
    .filter((name) => !parsedSet.has(name))
    .sort();
  if (missing.length > 0) {
    errors.push(`${BUNFIG} is missing registry-backed first-party quarantine excludes: ${missing.join(", ")}`);
  }

  return { errors, warnings };
};

export const pruneExpiredExcludes = ({
  bunfig,
  now = new Date(),
}: {
  bunfig: string;
  now?: Date;
}): { bunfig: string; pruned: string[] } => {
  const range = findExcludeBlock(bunfig);
  if (range === undefined) return { bunfig, pruned: [] };
  const pruned: string[] = [];
  const block = bunfig
    .slice(range.start, range.end)
    .split("\n")
    .filter((line) => {
      const entry = parseEntry(line);
      if (
        entry === undefined ||
        entry.annotation !== "expires" ||
        !exactTimestamp(entry.timestamp) ||
        now.getTime() < Date.parse(entry.timestamp)
      ) {
        return true;
      }
      pruned.push(entry.name);
      return false;
    })
    .join("\n");
  return {
    bunfig: bunfig.slice(0, range.start) + block + bunfig.slice(range.end),
    pruned,
  };
};

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
    ["quarantine-prune.yml", pruneWorkflow, ["schedule", "workflow_dispatch"]],
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
      const dispatch = parsed.on.workflow_dispatch;
      if (
        !Array.isArray(schedule) ||
        schedule.length !== 1 ||
        typeof schedule[0] !== "object" ||
        schedule[0] === null ||
        !("cron" in schedule[0]) ||
        typeof schedule[0].cron !== "string" ||
        Object.keys(schedule[0]).length !== 1 ||
        !HOURLY_CRON.test(schedule[0].cron) ||
        (dispatch !== null &&
          (typeof dispatch !== "object" || Object.keys(dispatch).length !== 0))
      ) {
        return [`.github/workflows/${name} must declare one hourly schedule and unfiltered workflow_dispatch`];
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
        ["RELEASE_APP_ID", "${{ secrets.RELEASE_APP_ID }}"],
        ["RELEASE_APP_PRIVATE_KEY", "${{ secrets.RELEASE_APP_PRIVATE_KEY }}"],
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
