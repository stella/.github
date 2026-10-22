import { readFileSync } from "node:fs";
import { join } from "node:path";

type ErrorDiagnostic =
  | { kind: "advisory"; crate?: string; id: string; title: string }
  | { kind: "error"; code: string; message: string };
type Result = { errors: string[]; warnings: string[] };
type CommandResult = { exitCode: number; output: string };

const fail = (message: string): never => {
  throw new Error(message);
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const cratesFromGraphs = (graphsValue: unknown): string[] => {
  if (!Array.isArray(graphsValue)) return [];

  const crates = new Set<string>();
  for (const graphValue of graphsValue) {
    const graph = record(graphValue);
    const crate = record(graph?.Krate) ?? record(graph?.krate);
    if (typeof crate?.name === "string" && typeof crate.version === "string") {
      crates.add(`${crate.name}@${crate.version}`);
    }
  }
  return [...crates];
};

export const parseErrorDiagnostics = (output: string): ErrorDiagnostic[] => {
  const diagnostics: ErrorDiagnostic[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const diagnostic = record(value);
    const fields = record(diagnostic?.fields);
    if (diagnostic?.type !== "diagnostic" || fields?.severity !== "error") {
      continue;
    }
    const advisory = record(fields.advisory);
    if (typeof advisory?.id !== "string") {
      diagnostics.push({
        kind: "error",
        code: String(fields.code ?? "cargo-deny"),
        message: String(fields.message ?? "cargo-deny reported an error"),
      });
      continue;
    }
    const parsed = {
      kind: "advisory" as const,
      id: advisory.id,
      title:
        typeof advisory.title === "string"
          ? advisory.title
          : typeof fields.message === "string"
            ? fields.message
            : String(fields.code ?? "advisory"),
    };
    const crates = cratesFromGraphs(fields.graphs);
    if (crates.length === 0) diagnostics.push(parsed);
    else for (const crate of crates) diagnostics.push({ ...parsed, crate });
  }
  return diagnostics;
};

export const lockedCrates = (lockfile: string): Set<string> => {
  const parsed = Bun.TOML.parse(lockfile);
  const packages = parsed.package;
  if (!Array.isArray(packages)) fail("Cargo.lock does not contain package entries");
  const crates = new Set<string>();
  for (const value of packages) {
    const pkg = record(value);
    if (typeof pkg?.name !== "string" || typeof pkg.version !== "string") {
      fail("Cargo.lock contains an invalid package entry");
    }
    crates.add(`${pkg.name}@${pkg.version}`);
  }
  return crates;
};

type Waiver = { id: string; reason?: string };
const waivers = (config: string): Waiver[] => {
  const parsed = Bun.TOML.parse(config);
  const advisories = record(parsed.advisories);
  if (advisories?.ignore === undefined) return [];
  if (!Array.isArray(advisories.ignore)) fail("[advisories] ignore must be an array");
  return advisories.ignore.map((value) => {
    const waiver = record(value);
    if (typeof waiver?.id !== "string") {
      fail('every [advisories] ignore entry must use { id = "...", reason = "..." }');
    }
    return {
      id: waiver.id,
      reason: typeof waiver.reason === "string" ? waiver.reason : undefined,
    };
  });
};

const waiverKey = ({ id, reason }: Waiver): string => `${id}\0${reason ?? ""}`;

export const annotation = (level: "error" | "warning", message: string): string =>
  `::${level}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;

export const evaluate = ({
  baseConfig,
  baseLockfile,
  cargoDeny,
  changeEvent,
  config,
  headLockfile,
  now,
}: {
  baseConfig?: string;
  baseLockfile?: string;
  cargoDeny: CommandResult;
  changeEvent: boolean;
  config: string;
  headLockfile: string;
  now: Date;
}): Result => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsedWaivers = waivers(config);
  const baseWaivers = new Set(baseConfig === undefined ? [] : waivers(baseConfig).map(waiverKey));
  const today = now.toISOString().slice(0, 10);

  for (const waiver of parsedWaivers) {
    const reason = waiver.reason ?? "";
    if (!/(?:^|[;\s])owner:\s*[^;\s]+/u.test(reason)) {
      errors.push(`${waiver.id} waiver reason is missing owner: <name>`);
    }
    const expiry = /(?:^|[;\s])expires:\s*(\d{4}-\d{2}-\d{2})(?=[;\s]|$)/u.exec(reason)?.[1];
    if (expiry === undefined) {
      errors.push(`${waiver.id} waiver reason is missing expires: YYYY-MM-DD`);
      continue;
    }
    const parsedExpiry = new Date(`${expiry}T00:00:00Z`);
    const valid =
      /^\d{4}-\d{2}-\d{2}$/u.test(expiry) &&
      !Number.isNaN(parsedExpiry.valueOf()) &&
      parsedExpiry.toISOString().slice(0, 10) === expiry;
    if (!valid) {
      errors.push(`${waiver.id} waiver has an invalid expiry: ${expiry}`);
    } else if (expiry < today) {
      const message = `${waiver.id} waiver expired on ${expiry}`;
      if (changeEvent && baseWaivers.has(waiverKey(waiver))) warnings.push(message);
      else errors.push(message);
    }
  }

  const diagnostics = parseErrorDiagnostics(cargoDeny.output);
  if (cargoDeny.exitCode !== 0 && diagnostics.length === 0) {
    errors.push("cargo-deny exited nonzero without a parseable error advisory diagnostic");
    return { errors, warnings };
  }

  const attributedAdvisories: Array<
    Extract<ErrorDiagnostic, { kind: "advisory" }> & { crate: string }
  > = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === "error") {
      errors.push(`${diagnostic.code}: ${diagnostic.message}`);
      continue;
    }
    const advisory = diagnostic;
    if (advisory.crate === undefined) {
      errors.push(`${advisory.id}: cannot attribute advisory to a locked crate`);
    } else {
      attributedAdvisories.push(advisory);
    }
  }

  let newCrates = new Set<string>();
  if (changeEvent) {
    if (baseLockfile === undefined) {
      errors.push("base lockfile could not be read");
      return { errors, warnings };
    }
    const base = lockedCrates(baseLockfile);
    newCrates = new Set([...lockedCrates(headLockfile)].filter((crate) => !base.has(crate)));
  }

  for (const advisory of attributedAdvisories) {
    const message = `${advisory.id} affects ${advisory.crate}: ${advisory.title}`;
    if (!changeEvent || newCrates.has(advisory.crate)) errors.push(message);
    else warnings.push(message);
  }
  return { errors, warnings };
};

const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export const validateBaseSha = (sha: string): void => {
  if (sha !== "" && !/^[0-9a-f]{40}$/u.test(sha)) {
    fail("base-sha must be 40 lowercase hex characters");
  }
};

export const readBaseFiles = (
  directory: string,
  lockfilePath: string,
  configPath: string,
): { baseConfig?: string; baseLockfile?: string } => ({
  baseConfig: readOptional(join(directory, configPath)),
  baseLockfile: readOptional(join(directory, lockfilePath)),
});

export const baseInputs = (
  sha: string,
  directory: string,
  lockfilePath: string,
  configPath: string,
): { baseConfig?: string; baseLockfile?: string } => {
  validateBaseSha(sha);
  return sha === "" ? {} : readBaseFiles(directory, lockfilePath, configPath);
};

const run = (): void => {
  const manifest = process.env.INPUT_MANIFEST_PATH ?? "Cargo.toml";
  const configPath = process.env.INPUT_CONFIG ?? "deny.toml";
  const lockfilePath = process.env.INPUT_LOCKFILE ?? "Cargo.lock";
  const baseSha = process.env.INPUT_BASE_SHA ?? "";
  const baseDirectory = process.env.INPUT_BASE_DIRECTORY ?? ".cargo-deny-base";
  const base = baseInputs(baseSha, baseDirectory, lockfilePath, configPath);
  const result = Bun.spawnSync(
    ["cargo", "deny", "--manifest-path", manifest, "--format", "json", "check", "--config", configPath, "advisories"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  const checked = evaluate({
    ...base,
    cargoDeny: { exitCode: result.exitCode, output },
    changeEvent: baseSha !== "",
    config: readFileSync(configPath, "utf8"),
    headLockfile: readFileSync(lockfilePath, "utf8"),
    now: new Date(),
  });
  for (const warning of checked.warnings) console.log(annotation("warning", warning));
  for (const error of checked.errors) console.error(annotation("error", error));
  if (checked.errors.length > 0) process.exitCode = 1;
};

if (import.meta.main) run();
