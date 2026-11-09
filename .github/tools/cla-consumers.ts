import { YAML } from "bun";
import { readFile } from "node:fs/promises";

export const REQUIRED_BOTS = [
  "dependabot[bot]",
  "renovate[bot]",
  "github-actions[bot]",
  "stella-provenance-updater[bot]",
];
const REQUIRED_PR_EVENTS = ["opened", "synchronize", "reopened"];
const DAY_MS = 86_400_000;
const CLA_WORKFLOW = "stella/.github/.github/workflows/cla.yml@";
const PERMISSION_LEVEL = { none: 0, read: 1, write: 2 } as const;

type PermissionAccess = keyof typeof PERMISSION_LEVEL;
type ApiResult = { content?: string; commit?: { committer: { date: string } } };
type Config = { repositories: string[]; maxPinAgeDays: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string) => {
  if (!isRecord(value)) throw new Error(`${label} must be a mapping`);
  return value;
};

const permissions = (value: unknown) => {
  const parsed = record(value, "CLA permissions");
  const result = new Map<string, PermissionAccess>();
  for (const [scope, access] of Object.entries(parsed)) {
    if (access !== "none" && access !== "read" && access !== "write") {
      throw new Error(`invalid CLA permission: ${scope}`);
    }
    result.set(scope, access);
  }
  return result;
};

const declarations = (value: unknown, kind: "input" | "secret") => {
  const parsed = record(value ?? {}, `CLA ${kind} declarations`);
  const result = new Map<string, { required: boolean }>();
  for (const [name, value] of Object.entries(parsed)) {
    const definition = record(value, `CLA ${kind} ${name}`);
    const required = definition["required"];
    if (required !== undefined && typeof required !== "boolean") {
      throw new Error(`CLA ${kind} ${name} required must be boolean`);
    }
    if (kind === "input") {
      const type = definition["type"];
      if (type !== "string" && type !== "boolean" && type !== "number") {
        throw new Error(`CLA input ${name} must declare a workflow_call type`);
      }
    }
    result.set(name, { required: required === true });
  }
  return result;
};

export function inspectReusable(source: string) {
  const workflow = record(YAML.parse(source), "pinned CLA workflow");
  const on = record(workflow["on"], "pinned CLA triggers");
  if (!Object.hasOwn(on, "workflow_call"))
    throw new Error("pinned CLA workflow must expose workflow_call");
  const contract = record(on["workflow_call"] ?? {}, "pinned CLA workflow_call");
  const requiredPermissions = permissions(workflow["permissions"]);
  for (const job of Object.values(record(workflow["jobs"], "pinned CLA jobs"))) {
    const declared = record(job, "pinned CLA job")["permissions"];
    if (declared === undefined) continue;
    for (const [scope, access] of permissions(declared)) {
      const previous = requiredPermissions.get(scope) ?? "none";
      if (PERMISSION_LEVEL[access] > PERMISSION_LEVEL[previous])
        requiredPermissions.set(scope, access);
    }
  }
  return {
    permissions: requiredPermissions,
    inputs: declarations(contract["inputs"], "input"),
    secrets: declarations(contract["secrets"], "secret"),
  };
}

export function inspectCaller(source: string) {
  const workflow = record(YAML.parse(source), "CLA caller");
  const on = record(workflow["on"], "CLA caller triggers");
  const trigger = on["pull_request_target"];
  if (trigger === undefined) throw new Error("missing pull_request_target trigger");
  const pr = record(trigger ?? {}, "pull_request_target trigger");
  if (
    ["branches", "branches-ignore", "paths", "paths-ignore"].some((key) => Object.hasOwn(pr, key))
  ) {
    throw new Error("CLA trigger must cover every pull request");
  }
  const types = pr["types"];
  if (
    types !== undefined &&
    (!Array.isArray(types) || !REQUIRED_PR_EVENTS.every((event) => types.includes(event)))
  ) {
    throw new Error("CLA trigger must cover opened, synchronize and reopened pull requests");
  }
  const comment = on["issue_comment"];
  if (comment === undefined) throw new Error("CLA trigger must cover created signing comments");
  const commentTypes =
    comment === null ? undefined : record(comment, "issue_comment trigger")["types"];
  if (
    commentTypes !== undefined &&
    (!Array.isArray(commentTypes) || !commentTypes.includes("created"))
  ) {
    throw new Error("CLA trigger must cover created signing comments");
  }
  const callers: Record<string, unknown>[] = [];
  for (const job of Object.values(record(workflow["jobs"], "CLA jobs"))) {
    const candidate = record(job, "CLA job");
    const uses = candidate["uses"];
    if (typeof uses === "string" && uses.startsWith(CLA_WORKFLOW)) callers.push(candidate);
  }
  if (callers.length !== 1) throw new Error("expected one shared CLA caller");
  const caller = callers.at(0);
  if (!caller) throw new Error("missing shared CLA caller");
  if (Object.hasOwn(caller, "needs")) throw new Error("CLA caller must not declare needs");
  const folded = String(caller["if"] ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  const privateGuard = /^!github\.event\.repository\.private && \(\s*/u;
  const condition = privateGuard.test(folded)
    ? folded.replace(privateGuard, "").replace(/\s*\)$/u, "")
    : folded;
  // Require the PR arm to be unconditional; signature/recheck filtering belongs
  // only in the issue_comment arm. Never evaluate repository expressions here.
  const prArm =
    "(?:\\(\\s*github\\.event_name == 'pull_request_target'\\s*\\)|github\\.event_name == 'pull_request_target')";
  const commentArm =
    "\\(\\s*github\\.event_name == 'issue_comment'\\s*&&\\s*github\\.event\\.issue\\.pull_request\\s*&&\\s*\\(\\s*github\\.event\\.comment\\.body == 'recheck'\\s*\\|\\|\\s*github\\.event\\.comment\\.body == 'I have read the CLA Document and I hereby sign the CLA'\\s*\\)\\s*\\)";
  if (!new RegExp(`^${prArm}\\s*\\|\\|\\s*${commentArm}$`, "u").test(condition)) {
    throw new Error("CLA caller must run for every pull_request_target, including bots");
  }
  const inputs = record(caller["with"] ?? {}, "CLA caller inputs");
  const allowlist = inputs["allowlist"];
  if (typeof allowlist !== "string") throw new Error("CLA caller must declare its bot allowlist");
  const bots = new Set(allowlist.split(",").map((name) => name.trim()));
  for (const bot of REQUIRED_BOTS) {
    if (!bots.has(bot)) throw new Error(`missing allowlisted bot: ${bot}`);
  }
  const uses = caller["uses"];
  if (typeof uses !== "string") throw new Error("missing shared CLA workflow pin");
  const sha = uses.slice(CLA_WORKFLOW.length);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("CLA workflow must use a full commit SHA");
  const secrets = record(caller["secrets"] ?? {}, "explicit CLA caller secrets");
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== "string")
      throw new Error(`CLA secret ${name} must be a string expression`);
  }
  return {
    sha,
    inputs,
    secrets,
    permissions: permissions(caller["permissions"] ?? workflow["permissions"]),
  };
}

export function validateCallerContract(
  caller: ReturnType<typeof inspectCaller>,
  contract: ReturnType<typeof inspectReusable>,
) {
  for (const [scope, access] of contract.permissions) {
    const granted = caller.permissions.get(scope) ?? "none";
    if (PERMISSION_LEVEL[granted] < PERMISSION_LEVEL[access]) {
      throw new Error(`CLA caller requires ${scope}: ${access}`);
    }
  }
  for (const kind of ["inputs", "secrets"] as const) {
    const declared = contract[kind];
    const supplied = caller[kind];
    for (const name of Object.keys(supplied)) {
      if (!declared.has(name)) throw new Error(`undeclared CLA ${kind}: ${name}`);
    }
    for (const [name, { required }] of declared) {
      if (required && !Object.hasOwn(supplied, name))
        throw new Error(`missing required CLA ${kind}: ${name}`);
    }
  }
}

export function checkPinAge(date: string, maxPinAgeDays: number, now = Date.now()): void {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxPinAgeDays * DAY_MS) {
    throw new Error(`CLA workflow pin must be at most ${maxPinAgeDays} days old`);
  }
}

export async function auditConsumers(config: Config, api: (path: string) => Promise<ApiResult>) {
  const pins = new Map<
    string,
    { commit: ApiResult; contract: ReturnType<typeof inspectReusable> }
  >();
  const failures: string[] = [];
  for (const repository of config.repositories) {
    try {
      const file = await api(`repos/stella/${repository}/contents/.github/workflows/cla.yml`);
      if (typeof file.content !== "string") throw new Error("missing CLA workflow content");
      const caller = inspectCaller(Buffer.from(file.content, "base64").toString("utf8"));
      let pin = pins.get(caller.sha);
      if (!pin) {
        const commit = await api(`repos/stella/.github/commits/${caller.sha}`);
        const reusable = await api(
          `repos/stella/.github/contents/.github/workflows/cla.yml?ref=${caller.sha}`,
        );
        if (typeof reusable.content !== "string")
          throw new Error("missing pinned CLA workflow content");
        pin = {
          commit,
          contract: inspectReusable(Buffer.from(reusable.content, "base64").toString("utf8")),
        };
        pins.set(caller.sha, pin);
      }
      if (!pin.commit.commit?.committer.date) throw new Error("missing CLA commit date");
      checkPinAge(pin.commit.commit.committer.date, config.maxPinAgeDays);
      validateCallerContract(caller, pin.contract);
      console.log(`${repository}: CLA caller OK (${caller.sha})`);
    } catch (error) {
      failures.push(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) {
  const config = JSON.parse(
    await readFile(new URL("./cla-consumers.json", import.meta.url), "utf8"),
  );
  const api = async (path: string) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
    return response.json();
  };
  await auditConsumers(config, api);
}
