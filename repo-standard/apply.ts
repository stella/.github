import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import template from "./ruleset.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type Entry = { gate: string; extraChecks: string[]; signatures: boolean; enabled: boolean };
export type Inventory = Record<string, Entry>;
export type Rule = { type: string; parameters?: ObjectValue };
export type Ruleset = {
  name: string; target: string; enforcement: string;
  conditions: ObjectValue; bypass_actors: ObjectValue[]; rules: Rule[];
  id?: number; [key: string]: unknown;
};
const NAME = template.name;
const BYPASS_VISIBILITY_ERROR = "INSUFFICIENT_PERMISSION: bypass_actors unavailable; GitHub requires write access to the ruleset to expose bypass actors";
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/u;
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

export type Options = { inventory: string; mode: "dry-run" | "check" | "apply"; repos: string[]; backupDir?: string };
export function parseArgs(args: string[]): Options {
  let inventory: string | undefined, backupDir: string | undefined, mode: Options["mode"] | undefined;
  const repos: string[] = [];
  const selectMode = (next: Options["mode"]) => {
    if (mode) throw new Error("Choose exactly one of --dry-run, --check, or apply");
    mode = next;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--inventory" || arg === "--backup-dir") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--inventory") inventory = value; else backupDir = value;
    } else if (arg === "--dry-run") selectMode("dry-run");
    else if (arg === "--check") selectMode("check");
    else if (arg === "apply") selectMode("apply");
    else if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (arg) repos.push(arg);
  }
  if (!inventory || !mode || (mode === "apply" && (!repos.length || !backupDir)) || (mode !== "apply" && repos.length)) {
    throw new Error("Usage: bun repo-standard/apply.ts --inventory <file> (--dry-run | --check | apply <owner/repo...> --backup-dir <dir>)");
  }
  return { inventory, mode, repos, backupDir };
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
export function main(args: string[]): number {
  const options = parseArgs(args);
  const inventory = parseInventory(JSON.parse(readFileSync(options.inventory, "utf8")));
  if (options.mode === "check") {
    const owners = [...new Set(Object.keys(inventory).map((repo) => repo.split("/")[0]))];
    const repositories: LiveRepository[] = [];
    for (const owner of owners) {
      for (const repo of pages(`orgs/${owner}/repos?type=all`)) {
        if (typeof repo.full_name !== "string" || !REPO.test(repo.full_name)) throw new Error("Invalid organization repository");
        repositories.push({ repo: repo.full_name, rulesets: readRulesets(repo.full_name) });
      }
    }
    const result = checkInventory(inventory, repositories);
    for (const line of result.lines) console.log(line);
    return result.exitCode;
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
