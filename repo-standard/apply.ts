import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import template from "./ruleset.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type Entry = { gate: string; extraChecks: string[]; signatures: boolean; enabled: boolean };
export type Inventory = Record<string, Entry>;
export type Tool = "bun" | "node" | "rust";
export type ToolchainException = { repo: string; tool: Tool; pin: string; reason: string; expires: string };
export type Toolchain = { bun: string; node: string; rust: string };
export type ToolObservation =
  | { status: "pinned"; pin: string }
  | { status: "not-pinned" }
  | { status: "malformed"; reason: string };
export type ToolchainObservation = { repo: string; tools: Record<Tool, ToolObservation> };
export type ToolchainAudit = { lines: string[]; failures: string[] };
export class ToolchainParseError extends Error {
  override name = "ToolchainParseError";
}
export type Rule = { type: string; parameters?: ObjectValue };
export type Ruleset = {
  name: string; target: string; enforcement: string;
  conditions: ObjectValue; bypass_actors: ObjectValue[]; rules: Rule[];
  id?: number; [key: string]: unknown;
};
const NAME = template.name;
const BYPASS_VISIBILITY_ERROR = "INSUFFICIENT_PERMISSION: bypass_actors unavailable; GitHub requires write access to the ruleset to expose bypass actors";
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseInventory(value: unknown): Inventory {
  if (!object(value) || !Object.keys(value).length) throw new Error("Inventory must be a nonempty repository-to-entry object");
  for (const [repo, entry] of Object.entries(value)) {
    if (!REPO.test(repo) || !object(entry) ||
      typeof entry.gate !== "string" || !entry.gate.trim() || entry.gate !== entry.gate.trim() ||
      !Array.isArray(entry.extraChecks) || entry.extraChecks.some((check) => typeof check !== "string" || !check.trim() || check !== check.trim()) ||
      typeof entry.signatures !== "boolean" || typeof entry.enabled !== "boolean" ||
      Object.keys(entry).some((key) => !["gate", "extraChecks", "signatures", "enabled"].includes(key))) {
      throw new Error(`Invalid inventory entry: ${repo}`);
    }
  }
  const identities = Object.keys(value).map((repo) => repo.toLowerCase());
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate repository identity");
  return value as Inventory;
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

// Diagnostics may describe a pin but never echo file contents: private
// repositories' manifests must not reach the audit log.
const SHOWN_PIN = /^[\w.@+-]{1,40}$/u;
function pinned(pin: unknown, field: string, prefix = ""): ToolObservation {
  if (typeof pin !== "string" || !pin.startsWith(prefix) || !VERSION.test(pin.slice(prefix.length))) {
    const shown = typeof pin === "string" && SHOWN_PIN.test(pin) ? ` ${JSON.stringify(pin)}` : "";
    return { status: "malformed", reason: `${field}${shown} is not ${prefix}<major.minor.patch>` };
  }
  return { status: "pinned", pin: pin.slice(prefix.length) };
}

export function parseToolObservations(repo: string, files: Record<Tool, string | null>): ToolchainObservation {
  let bun: ToolObservation = { status: "not-pinned" };
  if (files.bun !== null) {
    try {
      const manifest: unknown = JSON.parse(files.bun);
      bun = object(manifest)
        ? pinned(manifest.packageManager, "package.json packageManager", "bun@")
        : { status: "malformed", reason: "package.json is not a JSON object" };
    } catch { bun = { status: "malformed", reason: "package.json is not valid JSON" }; }
  }
  const node = files.node === null ? { status: "not-pinned" } as const : pinned(files.node.trim(), ".node-version");
  let rust: ToolObservation = { status: "not-pinned" };
  if (files.rust !== null) {
    try {
      const parsed: unknown = Bun.TOML.parse(files.rust);
      const toolchain = object(parsed) ? parsed.toolchain : undefined;
      rust = object(toolchain)
        ? pinned(toolchain.channel, "rust-toolchain.toml [toolchain] channel")
        : { status: "malformed", reason: "rust-toolchain.toml has no [toolchain] table" };
    } catch { rust = { status: "malformed", reason: "rust-toolchain.toml is not valid TOML" }; }
  }
  return { repo, tools: { bun, node, rust } };
}

export function parseToolchain(value: unknown): Toolchain {
  if (!object(value) || Object.keys(value).some((key) => !["bun", "node", "rust"].includes(key)) ||
    typeof value.bun !== "string" || !VERSION.test(value.bun) || typeof value.node !== "string" || !VERSION.test(value.node) ||
    typeof value.rust !== "string" || !VERSION.test(value.rust)) {
    throw new ToolchainParseError("Invalid toolchain standard");
  }
  return value as Toolchain;
}

/** Exceptions name repositories, so they come from the caller's private inventory, never this public file. */
export function parseToolchainExceptions(value: unknown): ToolchainException[] {
  if (!Array.isArray(value)) throw new ToolchainParseError("Invalid toolchain exceptions");
  const seen = new Set<string>();
  for (const exception of value) {
    // One entry per repository, tool and pin, so the outcome never depends on order.
    const key = object(exception) ? `${String(exception.repo ?? "").toLowerCase()}\0${String(exception.tool)}\0${String(exception.pin)}` : "";
    if (seen.has(key)) throw new ToolchainParseError("Duplicate toolchain exception");
    seen.add(key);
    if (!object(exception) || Object.keys(exception).some((key) => !["repo", "tool", "pin", "reason", "expires"].includes(key)) ||
      !REPO.test(String(exception.repo ?? "")) || !["bun", "node", "rust"].includes(String(exception.tool ?? "")) ||
      !VERSION.test(String(exception.pin ?? "")) || typeof exception.reason !== "string" || !exception.reason.trim() ||
      exception.reason !== exception.reason.trim() || typeof exception.expires !== "string" || !validDate(exception.expires)) {
      throw new ToolchainParseError("Invalid toolchain exception");
    }
  }
  return value as ToolchainException[];
}

export function auditToolchain(standard: Toolchain, exceptions: ToolchainException[], observations: ToolchainObservation[], today: string): ToolchainAudit {
  if (!validDate(today)) throw new Error("Invalid toolchain audit date");
  const lines: string[] = [], failures: string[] = [];
  for (const observation of observations) {
    for (const tool of ["bun", "node", "rust"] as const) {
      const seen = observation.tools[tool];
      if (seen.status === "not-pinned") {
        lines.push(`${observation.repo}: ${tool} not pinned`);
        continue;
      }
      if (seen.status === "malformed") {
        const line = `${observation.repo}: ${tool} pin has unsupported format: ${seen.reason}`;
        lines.push(line); failures.push(line); continue;
      }
      if (seen.pin === standard[tool]) continue;
      const exception = exceptions.find((item) => item.repo.toLowerCase() === observation.repo.toLowerCase() && item.tool === tool && item.pin === seen.pin);
      const mismatch = `${observation.repo}: ${tool} pinned ${seen.pin}, standard ${standard[tool]}`;
      if (exception && exception.expires >= today) {
        lines.push(`${mismatch}; exception through ${exception.expires}: ${exception.reason}`);
        continue;
      }
      const line = exception ? `${mismatch}; exception expired ${exception.expires}: ${exception.reason}` : mismatch;
      lines.push(line); failures.push(line);
    }
  }
  return { lines, failures };
}

export function render(entry: Entry): Ruleset {
  const body = structuredClone(template) as Ruleset;
  const status = body.rules.find((rule) => rule.type === "required_status_checks");
  if (!status?.parameters) throw new Error("Template is missing required_status_checks");
  status.parameters.required_status_checks = [...new Set([entry.gate, "cla", ...entry.extraChecks])].map((context) => ({ context }));
  if (entry.signatures) body.rules.push({ type: "required_signatures" });
  return body;
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key] as Json)]));
}

export function normalise(value: Ruleset): Ruleset {
  if (!Array.isArray(value.bypass_actors)) throw new Error(BYPASS_VISIBILITY_ERROR);
  const rules = value.rules.map((rule) => {
    const copy = structuredClone(rule);
    const parameters = copy.parameters;
    if (copy.type === "pull_request" && parameters) {
      if (Array.isArray(parameters.required_reviewers) && parameters.required_reviewers.length === 0) delete parameters.required_reviewers;
      if (parameters.require_extra_approval_for_unattributed_changes === false) delete parameters.require_extra_approval_for_unattributed_changes;
      const restriction = parameters.dismissal_restriction;
      if (object(restriction) && restriction.enabled === false && Array.isArray(restriction.allowed_actors) && restriction.allowed_actors.length === 0) delete parameters.dismissal_restriction;
    }
    if (copy.type === "required_status_checks" && parameters && Array.isArray(parameters.required_status_checks)) {
      parameters.required_status_checks = parameters.required_status_checks.map((check) => {
        if (!object(check)) throw new Error("Invalid required status check");
        const result = { ...check } as ObjectValue;
        if (result.integration_id === null) delete result.integration_id;
        return result;
      });
    }
    if (parameters && Object.keys(parameters).length === 0) delete copy.parameters;
    return copy;
  });
  return canonical({
    name: value.name, target: value.target, enforcement: value.enforcement,
    conditions: value.conditions, bypass_actors: value.bypass_actors, rules,
  } as Json) as Ruleset;
}

export type Difference = { rule: string; actual: unknown; expected: unknown };
export function diff(actual: Ruleset | null, expected: Ruleset): Difference[] {
  if (!actual) return [{ rule: "ruleset", actual: null, expected: normalise(expected) }];
  const before = normalise(actual), after = normalise(expected);
  const changes: Difference[] = [];
  for (const key of ["name", "target", "enforcement", "conditions", "bypass_actors"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push({ rule: key, actual: before[key], expected: after[key] });
  }
  const kinds = new Set([...before.rules, ...after.rules].map((rule) => rule.type));
  for (const kind of [...kinds].sort()) {
    const a = before.rules.filter((rule) => rule.type === kind), b = after.rules.filter((rule) => rule.type === kind);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ rule: `rules.${kind}`, actual: a, expected: b });
  }
  return changes;
}

export type LiveRepository = { repo: string; rulesets: Ruleset[] };
export function audit(inventory: Inventory, repositories: LiveRepository[]): string[] {
  const live = new Map(repositories.map((entry) => [entry.repo.toLowerCase(), entry]));
  const lines: string[] = [];
  for (const [repo, entry] of Object.entries(inventory)) {
    const observed = live.get(repo.toLowerCase());
    if (!observed) { lines.push(`${repo} repository: missing from organization listing`); continue; }
    const rulesets = observed.rulesets.filter((ruleset) => ruleset.name === NAME);
    if (rulesets.length > 1) { lines.push(`${repo} ruleset: multiple ${NAME} rulesets`); continue; }
    if (rulesets[0] && !Array.isArray(rulesets[0].bypass_actors)) {
      lines.push(`${repo} ${BYPASS_VISIBILITY_ERROR}`);
      continue;
    }
    for (const change of diff(rulesets[0] ?? null, render(entry))) lines.push(`${repo} ${change.rule}: ${JSON.stringify(change.actual)} -> ${JSON.stringify(change.expected)}`);
  }
  const listed = new Set(Object.keys(inventory).map((repo) => repo.toLowerCase()));
  for (const { repo, rulesets } of repositories) {
    if (listed.has(repo.toLowerCase())) continue;
    if (rulesets.some((ruleset) => ruleset.name === NAME || ruleset.rules.some((rule) => rule.type === "merge_queue"))) {
      lines.push(`${repo} inventory: unlisted repository with ${NAME} or merge_queue`);
    }
  }
  return lines;
}

export function checkInventory(inventory: Inventory, repositories: LiveRepository[]): { lines: string[]; exitCode: 0 | 1 } {
  const lines = audit(inventory, repositories);
  return { lines, exitCode: lines.length ? 1 : 0 };
}

export type Options = { inventory: string; mode: "dry-run" | "check" | "apply"; repos: string[]; backupDir?: string; toolchainExceptions?: string };
export function parseArgs(args: string[]): Options {
  let inventory: string | undefined, backupDir: string | undefined, toolchainExceptions: string | undefined, mode: Options["mode"] | undefined;
  const repos: string[] = [];
  const selectMode = (next: Options["mode"]) => {
    if (mode) throw new Error("Choose exactly one of --dry-run, --check, or apply");
    mode = next;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--inventory" || arg === "--backup-dir" || arg === "--toolchain-exceptions") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--inventory") inventory = value;
      else if (arg === "--backup-dir") backupDir = value;
      else toolchainExceptions = value;
    } else if (arg === "--dry-run") selectMode("dry-run");
    else if (arg === "--check") selectMode("check");
    else if (arg === "apply") selectMode("apply");
    else if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (arg) repos.push(arg);
  }
  if (!inventory || !mode || (mode === "apply" && (!repos.length || !backupDir)) || (mode !== "apply" && repos.length) ||
    (toolchainExceptions !== undefined && mode !== "check")) {
    throw new Error("Usage: bun repo-standard/apply.ts --inventory <file> (--dry-run | --check [--toolchain-exceptions <file>] | apply <owner/repo...> --backup-dir <dir>)");
  }
  return { inventory, mode, repos, backupDir, ...(toolchainExceptions === undefined ? {} : { toolchainExceptions }) };
}

function gh(args: string[], input?: unknown): unknown {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input), maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh api failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
function pages(path: string): Record<string, unknown>[] {
  const result = gh([`${path}${path.includes("?") ? "&" : "?"}per_page=100`, "--paginate", "--slurp"]);
  if (!Array.isArray(result) || result.some((page) => !Array.isArray(page))) throw new Error(`Invalid GitHub list response: ${path}`);
  return result.flat();
}
function readRulesets(repo: string): Ruleset[] {
  return pages(`repos/${repo}/rulesets?includes_parents=true`).map((rule) => {
    if (!Number.isSafeInteger(rule.id) || Number(rule.id) <= 0) throw new Error(`Invalid ruleset id: ${repo}`);
    const response = gh([`repos/${repo}/rulesets/${rule.id}`]);
    if (!object(response) || !Array.isArray(response.rules) || typeof response.name !== "string") throw new Error(`Invalid ruleset response: ${repo}`);
    return response as Ruleset;
  });
}
const REPOSITORY_TOOLCHAINS_QUERY = `
  query($owner: String!, $cursor: String) {
    organization(login: $owner) {
      repositories(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          nameWithOwner
          bun: object(expression: "HEAD:package.json") { ... on Blob { text } }
          node: object(expression: "HEAD:.node-version") { ... on Blob { text } }
          rust: object(expression: "HEAD:rust-toolchain.toml") { ... on Blob { text } }
        }
      }
    }
  }
`;
function readRepositories(owner: string): { repos: string[]; observations: ToolchainObservation[] } {
  const repos: string[] = [], observations: ToolchainObservation[] = [];
  let cursor: string | null = null;
  do {
    const args = ["graphql", "-f", `query=${REPOSITORY_TOOLCHAINS_QUERY}`, "-f", `owner=${owner}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const response = gh(args);
    const organization = object(response) && object(response.data) ? response.data.organization : undefined;
    const connection = object(organization) ? organization.repositories : undefined;
    if (!object(connection) || !Array.isArray(connection.nodes) || !object(connection.pageInfo)) throw new Error(`Invalid organization repository response: ${owner}`);
    for (const node of connection.nodes) {
      if (!object(node) || typeof node.nameWithOwner !== "string" || !REPO.test(node.nameWithOwner)) throw new Error("Invalid organization repository");
      const files = Object.fromEntries((["bun", "node", "rust"] as const).map((tool) => {
        const blob = node[tool];
        if (blob === null) return [tool, null];
        if (!object(blob) || typeof blob.text !== "string") throw new Error(`Invalid ${tool} toolchain file response: ${node.nameWithOwner}`);
        return [tool, blob.text];
      })) as Record<Tool, string | null>;
      repos.push(node.nameWithOwner);
      observations.push(parseToolObservations(node.nameWithOwner, files));
    }
    if (connection.pageInfo.hasNextPage === false) cursor = null;
    else if (connection.pageInfo.hasNextPage === true && typeof connection.pageInfo.endCursor === "string" && connection.pageInfo.endCursor) cursor = connection.pageInfo.endCursor;
    else throw new Error(`Invalid organization repository pagination: ${owner}`);
  } while (cursor);
  return { repos, observations };
}
export function main(args: string[]): number {
  const options = parseArgs(args);
  const inventory = parseInventory(JSON.parse(readFileSync(options.inventory, "utf8")));
  if (options.mode === "check") {
    const standard = parseToolchain(JSON.parse(readFileSync(new URL("./toolchain.json", import.meta.url), "utf8")));
    const exceptions = options.toolchainExceptions === undefined
      ? []
      : parseToolchainExceptions(JSON.parse(readFileSync(options.toolchainExceptions, "utf8")));
    const owners = [...new Set(Object.keys(inventory).map((repo) => repo.split("/")[0]))];
    const repositories: LiveRepository[] = [];
    const observations: ToolchainObservation[] = [];
    for (const owner of owners) {
      const organization = readRepositories(owner!);
      observations.push(...organization.observations);
      for (const repo of organization.repos) {
        repositories.push({ repo, rulesets: readRulesets(repo) });
      }
    }
    const result = checkInventory(inventory, repositories);
    const toolchains = auditToolchain(standard, exceptions, observations, new Date().toISOString().slice(0, 10));
    for (const line of result.lines) console.log(line);
    for (const line of toolchains.lines) console.log(line);
    return result.exitCode || toolchains.failures.length ? 1 : 0;
  }
  const selected = options.mode === "apply" ? options.repos : Object.keys(inventory);
  // Validate every target before any write or backup.
  for (const repo of selected) {
    if (!Object.hasOwn(inventory, repo)) throw new Error(`Repository is not in inventory: ${repo}`);
    if (options.mode === "apply" && !inventory[repo]!.enabled) throw new Error(`Repository is not enabled: ${repo}`);
  }
  for (const repo of selected) {
    const rulesets = readRulesets(repo).filter((ruleset) => ruleset.name === NAME);
    if (rulesets.length > 1) throw new Error(`Multiple ${NAME} rulesets: ${repo}`);
    const live = rulesets[0] ?? null;
    const desired = render(inventory[repo]!);
    const changes = diff(live, desired);
    if (options.mode === "dry-run") {
      if (!changes.length) console.log(`${repo}: no drift`);
      for (const change of changes) console.log(`${repo} ${change.rule}: ${JSON.stringify(change.actual)} -> ${JSON.stringify(change.expected)}`);
      continue;
    }
    if (!changes.length) { console.log(`${repo}: no drift`); continue; }
    if (live && (live.source_type !== "Repository" || String(live.source).toLowerCase() !== repo.toLowerCase())) throw new Error(`Refusing to update inherited ruleset: ${repo}`);
    mkdirSync(options.backupDir!, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backup = join(options.backupDir!, `${repo.replace("/", "-")}-${live?.id ?? "new"}-${timestamp}.json`);
    // A create backs up null: there was no ruleset before this operation.
    writeFileSync(backup, `${JSON.stringify(live, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    gh([live ? `repos/${repo}/rulesets/${live.id}` : `repos/${repo}/rulesets`, "--method", live ? "PUT" : "POST", "--input", "-"], desired);
    console.log(`${repo}: applied; backup ${backup}`);
  }
  return 0;
}
if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
