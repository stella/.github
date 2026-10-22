import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkQuarantinePolicy,
  exactTimestamp,
  isChangeEvent,
  pruneExpiredExcludes,
  REQUIRED_RELEASE_AGE_SECONDS,
  type CheckResult,
} from "./check";
import { readLockedRegistryVersions } from "./lockfile";

const read = (root: string, name: string): string | undefined => {
  const file = path.join(root, name);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

const tracked = (root: string): string[] => {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
};

type MarkedEntry = { annotation: "excluded-since" | "expires"; name: string; timestamp: string };

const markedList = (source: string, key: string, file: string): { entries: MarkedEntry[]; errors: string[] } => {
  const errors: string[] = [];
  const declaration = new RegExp(`^[ \\t]*${key}[ \\t]*[:=][ \\t]*(?:\\[)?`, "mu").exec(source);
  if (declaration === null) return { entries: [], errors: [`${file} must declare ${key} as a list`] };
  const bracketed = source.slice(declaration.index, declaration.index + declaration[0].length).includes("[");
  const nextTopLevel = source.slice(declaration.index + declaration[0].length).search(/^\S/mu);
  const end = bracketed ? source.indexOf("]", declaration.index) : nextTopLevel < 0 ? source.length : declaration.index + declaration[0].length + nextTopLevel;
  if (end < 0) return { entries: [], errors: [`${file} has an unterminated ${key} list`] };
  const entries = source.slice(declaration.index, end).split("\n").flatMap((line) => {
    if (!/^\s*(?:-\s*)?"/u.test(line)) return [];
    const match = /^\s*(?:-\s*)?"(?<name>[^"]+)"\s*,?\s*#\s*(?<marker>quarantine-expires:|quarantine-excluded-since:)\s*(?<timestamp>\S+)\s*$/u.exec(line);
    if (match?.groups === undefined) {
      errors.push(`${file} has an unannotated or malformed quarantine exclude: ${line.trim()}`);
      return [];
    }
    return [{
      annotation: match.groups.marker === "quarantine-expires:" ? "expires" as const : "excluded-since" as const,
      name: match.groups.name!, timestamp: match.groups.timestamp!,
    }];
  });
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) errors.push(`${file} ${key} must not contain duplicates`);
  return { entries, errors };
};

const validateMarkers = ({ entries, file, firstParty, now, inherited }: {
  entries: MarkedEntry[]; file: string; firstParty: (name: string) => boolean; now: Date; inherited: boolean;
}): CheckResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const temporal = (message: string) => (inherited ? warnings : errors).push(message);
  for (const entry of entries) {
    if (!exactTimestamp(entry.timestamp)) {
      errors.push(`${file} quarantine exclude "${entry.name}" has an invalid UTC timestamp: ${entry.timestamp}`);
      continue;
    }
    const time = Date.parse(entry.timestamp);
    if (firstParty(entry.name)) {
      if (entry.annotation !== "excluded-since") errors.push(`${file} first-party quarantine exclude "${entry.name}" must use quarantine-excluded-since:`);
      else if (time > now.getTime()) temporal(`${file} first-party quarantine exclude "${entry.name}" has a future exclusion date`);
    } else if (entry.annotation !== "expires") {
      errors.push(`${file} third-party quarantine exclude "${entry.name}" must use quarantine-expires:`);
    } else if (time <= now.getTime()) {
      temporal(`${file} temporary quarantine exclude "${entry.name}" expired at ${entry.timestamp} and is still present`);
    } else if (time > now.getTime() + REQUIRED_RELEASE_AGE_SECONDS * 1000) {
      temporal(`${file} temporary quarantine exclude "${entry.name}" expires more than ${REQUIRED_RELEASE_AGE_SECONDS} seconds after the policy clock`);
    }
  }
  return { errors, warnings };
};

export const readPnpmLockedRegistryVersions = (lockfile: string) => {
  const packages = /^packages:\s*$([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/mu.exec(lockfile)?.[1] ?? "";
  const results = new Map<string, { name: string; version: string }>();
  for (const match of packages.matchAll(/^\s{2,}['"]?(?<key>(?:@[^/]+\/)?[^@'"\s:]+@[^'"\s:]+)['"]?:/gmu)) {
    const key = match.groups?.key;
    if (key === undefined) continue;
    const clean = key.replace(/\(.+$/u, "");
    const at = clean.lastIndexOf("@");
    const name = clean.slice(0, at);
    const version = clean.slice(at + 1);
    if (/^(?:link:|file:|workspace:)/u.test(version)) continue;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error(`pnpm-lock.yaml package ${key} uses a non-registry resolution`);
    }
    results.set(`${name}@${version}`, { name, version });
  }
  return [...results.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
};

export const checkPnpmPolicy = ({ workspace, lockfile, packageJson, npmrc, baseWorkspace, eventName = "push", now }: {
  workspace: string; lockfile: string; packageJson: string; npmrc?: string; baseWorkspace?: string; eventName?: string; now: Date;
}): CheckResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = Bun.YAML.parse(workspace) as Record<string, unknown>;
  if (parsed.minimumReleaseAge !== 7200) errors.push("pnpm-workspace.yaml must set minimumReleaseAge: 7200");
  if (!Array.isArray(parsed.minimumReleaseAgeExclude)) errors.push("pnpm-workspace.yaml must declare minimumReleaseAgeExclude as a list");
  if (workspace.match(/^\s*dangerouslyAllowAllBuilds:\s*true\s*$/mu)) errors.push("pnpm-workspace.yaml must not enable dangerouslyAllowAllBuilds");
  const marked = markedList(workspace, "minimumReleaseAgeExclude", "pnpm-workspace.yaml");
  errors.push(...marked.errors);
  const inherited = isChangeEvent(eventName) && baseWorkspace === workspace;
  const markers = validateMarkers({ entries: marked.entries, file: "pnpm-workspace.yaml", firstParty: (name) => name.startsWith("@stll/"), now, inherited });
  errors.push(...markers.errors); warnings.push(...markers.warnings);
  const manager = (JSON.parse(packageJson) as Record<string, unknown>).packageManager;
  const version = typeof manager === "string" ? /^pnpm@(\d+)\.(\d+)\.(\d+)$/u.exec(manager) : null;
  if (version === null || Number(version[1]) < 10 || (Number(version[1]) === 10 && Number(version[2]) < 16)) errors.push("package.json packageManager must pin pnpm >= 10.16.0");
  if (npmrc?.split("\n").some((line) => /^\s*registry\s*=/u.test(line) && !line.includes("https://registry.npmjs.org"))) errors.push(".npmrc must not configure a non-default registry");
  const locked = new Set(readPnpmLockedRegistryVersions(lockfile).map(({ name }) => name));
  if (parsed.onlyBuiltDependencies !== undefined && !Array.isArray(parsed.onlyBuiltDependencies)) errors.push("pnpm-workspace.yaml onlyBuiltDependencies must be a list");
  for (const name of Array.isArray(parsed.onlyBuiltDependencies) ? parsed.onlyBuiltDependencies : []) {
    if (typeof name !== "string" || !locked.has(name)) errors.push(`pnpm-workspace.yaml onlyBuiltDependencies contains missing package: ${String(name)}`);
  }
  return { errors, warnings };
};

export const readCargoPackages = (lockfile: string) => {
  const parsed = Bun.TOML.parse(lockfile) as { package?: Array<Record<string, unknown>> };
  return (parsed.package ?? []).map((item) => ({ name: String(item.name), version: String(item.version), source: typeof item.source === "string" ? item.source : undefined }));
};

export const checkCargoPolicy = ({ quarantine, config, lockfiles, baseQuarantine, eventName = "push", now }: {
  quarantine: string; config: string; lockfiles: Map<string, string>; baseQuarantine?: string; eventName?: string; now: Date;
}): CheckResult => {
  const marked = markedList(quarantine, "excludes", ".cargo/quarantine.toml");
  const errors = [...marked.errors]; const warnings: string[] = [];
  const markerResult = validateMarkers({ entries: marked.entries, file: ".cargo/quarantine.toml", firstParty: (name) => name.startsWith("stella-") || name.startsWith("stella_"), now, inherited: isChangeEvent(eventName) && quarantine === baseQuarantine });
  errors.push(...markerResult.errors); warnings.push(...markerResult.warnings);
  const excludes = new Set(marked.entries.map(({ name }) => name));
  const seen = new Set<string>();
  for (const [file, contents] of lockfiles) for (const pkg of readCargoPackages(contents)) {
    const key = `${pkg.name}@${pkg.version}`; seen.add(key);
    if (pkg.source !== undefined && pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" && pkg.source !== "sparse+https://index.crates.io/" && !excludes.has(key)) errors.push(`${file} ${key} uses unsupported source ${pkg.source}`);
  }
  for (const entry of marked.entries) {
    const firstParty = entry.name.startsWith("stella-") || entry.name.startsWith("stella_");
    if (!firstParty && !/^[^@]+@[^@]+$/u.test(entry.name)) errors.push(`.cargo/quarantine.toml third-party exclude "${entry.name}" must use name@version`);
    if (!firstParty && !seen.has(entry.name)) errors.push(`.cargo/quarantine.toml contains stale exclude: ${entry.name}`);
  }
  const parsedConfig = Bun.TOML.parse(config) as { registry?: Record<string, unknown> };
  if (parsedConfig.registry?.["global-min-publish-age"] !== "5 days") errors.push('.cargo/config.toml must set [registry] global-min-publish-age = "5 days"');
  return { errors, warnings };
};

export const checkBunTrustedDependencies = (packageJson: string, lockfile: string): string[] => {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>;
  if (!Array.isArray(parsed.trustedDependencies) || parsed.trustedDependencies.some((v) => typeof v !== "string")) return ["package.json must declare trustedDependencies as an array of strings"];
  const values = parsed.trustedDependencies as string[];
  const errors: string[] = [];
  if (new Set(values).size !== values.length) errors.push("package.json trustedDependencies must not contain duplicates");
  const locked = new Set(readLockedRegistryVersions(lockfile).map(({ name }) => name));
  for (const name of values) if (!locked.has(name)) errors.push(`package.json trustedDependencies contains missing package: ${name}`);
  return errors;
};

export const checkRepositoryPolicy = ({ root, eventName, now }: { root: string; eventName: string; now: Date }): CheckResult => {
  const files = tracked(root); const errors: string[] = []; const warnings: string[] = [];
  const unsupported = files.filter((file) => /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/u.test(file));
  if (unsupported.length) errors.push(`unsupported lockfiles: ${unsupported.join(", ")}`);
  const cargoLocks = files.filter((file) => /(^|\/)Cargo\.lock$/u.test(file));
  const bun = files.includes("bun.lock"); const pnpm = files.includes("pnpm-lock.yaml");
  if (!bun && !pnpm && cargoLocks.length === 0 && files.some((file) => /(^|\/)(?:package\.json|Cargo\.toml)$/u.test(file))) errors.push("unlocked package manifest cannot be screened");
  const baseRoot = path.join(root, ".quarantine-base");
  if (bun) {
    const bunfig = read(root, "bunfig.toml"); const lockfile = read(root, "bun.lock")!; const packageJson = read(root, "package.json");
    if (bunfig === undefined) errors.push("bunfig.toml is required for bun.lock");
    else { const result = checkQuarantinePolicy({ bunfig, lockfile, now, eventName, baseBunfig: read(baseRoot, "bunfig.toml"), baseLockfile: read(baseRoot, "bun.lock"), npmrcPresent: existsSync(path.join(root, ".npmrc")), baseNpmrcPresent: existsSync(path.join(baseRoot, ".npmrc")) }); errors.push(...result.errors); warnings.push(...result.warnings); }
    if (packageJson === undefined) errors.push("package.json is required for bun.lock"); else errors.push(...checkBunTrustedDependencies(packageJson, lockfile));
  }
  if (pnpm) {
    const workspace = read(root, "pnpm-workspace.yaml"); const packageJson = read(root, "package.json");
    if (workspace === undefined || packageJson === undefined) errors.push("pnpm-workspace.yaml and package.json are required for pnpm-lock.yaml");
    else { const result = checkPnpmPolicy({ workspace, lockfile: read(root, "pnpm-lock.yaml")!, packageJson, npmrc: read(root, ".npmrc"), baseWorkspace: read(baseRoot, "pnpm-workspace.yaml"), eventName, now }); errors.push(...result.errors); warnings.push(...result.warnings); }
  }
  if (cargoLocks.length) {
    const quarantine = read(root, ".cargo/quarantine.toml"); const config = read(root, ".cargo/config.toml");
    if (quarantine === undefined || config === undefined) errors.push(".cargo/quarantine.toml and .cargo/config.toml are required when Cargo.lock is tracked");
    else { const result = checkCargoPolicy({ quarantine, config, lockfiles: new Map(cargoLocks.map((file) => [file, read(root, file)!])), baseQuarantine: read(baseRoot, ".cargo/quarantine.toml"), eventName, now }); errors.push(...result.errors); warnings.push(...result.warnings); }
  }
  return { errors, warnings };
};

export const pruneRepositoryExcludes = ({ root, now }: { root: string; now: Date }): number => {
  let count = 0;
  for (const [file, key] of [["bunfig.toml", "minimumReleaseAgeExcludes"], ["pnpm-workspace.yaml", "minimumReleaseAgeExclude"], [".cargo/quarantine.toml", "excludes"]] as const) {
    const source = read(root, file); if (source === undefined) continue;
    if (file === "bunfig.toml") { const result = pruneExpiredExcludes({ bunfig: source, now }); if (result.pruned.length) writeFileSync(path.join(root, file), result.bunfig); count += result.pruned.length; continue; }
    const marked = markedList(source, key, file); const expired = new Set(marked.entries.filter((e) => e.annotation === "expires" && exactTimestamp(e.timestamp) && Date.parse(e.timestamp) <= now.getTime()).map((e) => e.name));
    if (expired.size) writeFileSync(path.join(root, file), source.split("\n").filter((line) => ![...expired].some((name) => line.includes(`"${name}"`))).join("\n"));
    count += expired.size;
  }
  return count;
};
