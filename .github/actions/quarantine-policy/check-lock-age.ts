import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readNewLockedRegistryVersions } from "./lockfile";
import {
  exactTimestamp,
  isChangeEvent,
  NPM_REGISTRY,
  pathEntryExists,
  readParsedExcludes,
  REQUIRED_RELEASE_AGE_SECONDS,
} from "./check";
import { readCargoPackages, readPnpmLockedRegistryVersions } from "./ecosystems";

export {
  type LockedRegistryVersion,
  readLockedRegistryVersions,
  readNewLockedRegistryVersions,
} from "./lockfile";

const BUNFIG = "bunfig.toml";
const LOCKFILE = "bun.lock";
const MAX_REGISTRY_CONCURRENCY = 8;
const MAX_REGISTRY_ATTEMPTS = 3;
const REGISTRY_RETRY_DELAY_MS = 500;
const REGISTRY_TIMEOUT_MS = 10_000;
export type LoadPackageMetadata = (name: string) => Promise<unknown>;

export const loadRegistryMetadata: LoadPackageMetadata = async (name) => {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(name)}`;
  let lastError = "unknown registry failure";
  for (let attempt = 0; attempt < MAX_REGISTRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      if (response.ok) return response.json();
      lastError = `npm registry returned HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < MAX_REGISTRY_ATTEMPTS) {
      await Bun.sleep(REGISTRY_RETRY_DELAY_MS * 2 ** attempt);
    }
  }
  throw new Error(lastError);
};

export const cratesIndexPath = (name: string): string => {
  const value = name.toLowerCase();
  if (value.length === 1) return `1/${value}`;
  if (value.length === 2) return `2/${value}`;
  if (value.length === 3) return `3/${value[0]}/${value}`;
  return `${value.slice(0, 2)}/${value.slice(2, 4)}/${value}`;
};

export const checkNewCargoReleaseAges = async ({ lockfiles, baseLockfiles = new Map(), excludes = [], now, loadIndex, loadApi }: {
  lockfiles: Map<string, string>; baseLockfiles?: Map<string, string>; excludes?: string[]; now: Date;
  loadIndex: (name: string, indexPath: string) => Promise<string>;
  loadApi: (name: string, version: string) => Promise<unknown>;
}): Promise<{ checked: number; errors: string[] }> => {
  const candidates = new Map<string, { name: string; version: string }>();
  const excluded = new Set(excludes);
  for (const [file, contents] of lockfiles) {
    const base = new Set(readCargoPackages(baseLockfiles.get(file) ?? "").map((p) => `${p.name}@${p.version}`));
    for (const pkg of readCargoPackages(contents)) {
      const key = `${pkg.name}@${pkg.version}`;
      if (pkg.source !== undefined && (pkg.source === "registry+https://github.com/rust-lang/crates.io-index" || pkg.source === "sparse+https://index.crates.io/") && !base.has(key) && !excluded.has(key) && !excluded.has(pkg.name)) candidates.set(key, pkg);
    }
  }
  const errors: string[] = []; const indexCache = new Map<string, Promise<string>>();
  const cutoff = now.getTime() - REQUIRED_RELEASE_AGE_SECONDS * 1000;
  await Promise.all([...candidates.values()].map(async ({ name, version }) => {
    try {
      let promise = indexCache.get(name);
      if (promise === undefined) { promise = loadIndex(name, cratesIndexPath(name)); indexCache.set(name, promise); }
      const index = await promise;
      const record = index.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).find((item) => item.vers === version);
      let published = typeof record?.pubtime === "string" ? record.pubtime : undefined;
      if (published === undefined) {
        const api = await loadApi(name, version) as { version?: { created_at?: unknown } };
        published = typeof api?.version?.created_at === "string" ? api.version.created_at : undefined;
      }
      if (published === undefined) { errors.push(`${name}@${version}: crates.io has no publication time`); return; }
      const timestamp = Date.parse(published);
      if (Number.isNaN(timestamp)) { errors.push(`${name}@${version}: crates.io returned an invalid publication time`); return; }
      if (timestamp > cutoff) errors.push(`${name}@${version}: locked version was published at ${new Date(timestamp).toISOString()} and is younger than ${REQUIRED_RELEASE_AGE_SECONDS} seconds`);
    } catch (error) { errors.push(`${name}@${version}: crates.io lookup failed: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  return { checked: candidates.size, errors: errors.sort() };
};

export const checkNewPnpmReleaseAges = async ({ workspace, baseWorkspace, lockfile, baseLockfile, eventName = "pull_request", now, loadMetadata = loadRegistryMetadata }: {
  workspace: string; baseWorkspace?: string; lockfile: string; baseLockfile?: string; eventName?: string; now: Date; loadMetadata?: LoadPackageMetadata;
}) => {
  const excludes = new Set(((Bun.YAML.parse(workspace) as Record<string, unknown>).minimumReleaseAgeExclude as unknown[] ?? []).filter((v): v is string => typeof v === "string"));
  const baseExcludes = new Set(((baseWorkspace === undefined ? {} : Bun.YAML.parse(baseWorkspace)) as Record<string, unknown>).minimumReleaseAgeExclude as string[] ?? []);
  const base = new Set(isChangeEvent(eventName) && baseWorkspace === workspace && baseLockfile !== undefined ? readPnpmLockedRegistryVersions(baseLockfile).map((v) => `${v.name}@${v.version}`) : []);
  const candidates = readPnpmLockedRegistryVersions(lockfile).filter((v) => (!base.has(`${v.name}@${v.version}`) || baseExcludes.has(v.name) || baseExcludes.has(`${v.name}@${v.version}`)) && !excludes.has(v.name) && !excludes.has(`${v.name}@${v.version}`));
  const bunLock = JSON.stringify({ packages: Object.fromEntries(candidates.map((v, i) => [i, [`${v.name}@${v.version}`, ""]])) });
  return checkNewLockedRegistryReleaseAges({ bunfig: `[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = []`, lockfile: bunLock, now, loadMetadata });
};

const readPublishTime = (
  metadata: unknown,
  version: string,
): string | undefined => {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("time" in metadata) ||
    typeof metadata.time !== "object" ||
    metadata.time === null
  ) {
    return undefined;
  }
  const entry = Object.entries(metadata.time).find(
    ([candidate]) => candidate === version,
  );
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
};

const readTrustedBaseExcludes = (baseBunfig: string | undefined): string[] | undefined => {
  if (baseBunfig === undefined) return undefined;
  try {
    return readParsedExcludes(baseBunfig);
  } catch {
    // An invalid historical policy cannot establish that its lockfile was screened.
    return undefined;
  }
};

export const checkNewLockedRegistryReleaseAges = async ({
  baseBunfig,
  baseLockfile,
  baseNpmrcPresent = false,
  eventName = "pull_request",
  bunfig,
  loadMetadata = loadRegistryMetadata,
  lockfile,
  now,
}: {
  eventName?: string;
  baseBunfig?: string;
  baseLockfile?: string;
  baseNpmrcPresent?: boolean;
  bunfig: string;
  loadMetadata?: LoadPackageMetadata;
  lockfile: string;
  now: Date;
}): Promise<{ checked: number; errors: string[] }> => {
  const excludes = new Set(readParsedExcludes(bunfig));
  const baseExcludes = baseNpmrcPresent ? undefined : readTrustedBaseExcludes(baseBunfig);
  const configUnchanged = isChangeEvent(eventName) && baseBunfig === bunfig;
  const candidates = readNewLockedRegistryVersions({
    baseExcludes: baseExcludes ?? [],
    baseLockfile: configUnchanged && baseExcludes !== undefined ? baseLockfile : undefined,
    lockfile,
  })
    .filter(
      ({ name, version }) =>
        !excludes.has(name) && !excludes.has(`${name}@${version}`),
    );
  const versionsByName = new Map<string, string[]>();
  for (const { name, version } of candidates) {
    const versions = versionsByName.get(name);
    if (versions === undefined) versionsByName.set(name, [version]);
    else versions.push(version);
  }

  const errors: string[] = [];
  const packages = [...versionsByName.entries()];
  let nextPackage = 0;
  const cutoff = now.getTime() - REQUIRED_RELEASE_AGE_SECONDS * 1000;
  const worker = async () => {
    while (nextPackage < packages.length) {
      const packageIndex = nextPackage;
      nextPackage++;
      const entry = packages[packageIndex];
      if (entry === undefined) continue;
      const [name, versions] = entry;
      let metadata: unknown;
      try {
        metadata = await loadMetadata(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${name}: registry metadata lookup failed: ${message}`);
        continue;
      }
      for (const version of versions) {
        const publishedAt = readPublishTime(metadata, version);
        if (publishedAt === undefined) {
          errors.push(`${name}@${version}: npm registry metadata has no publication time`);
          continue;
        }
        if (!exactTimestamp(publishedAt)) {
          errors.push(`${name}@${version}: npm registry returned an invalid publication time`);
          continue;
        }
        const publishedAtMs = Date.parse(publishedAt);
        if (publishedAtMs > cutoff) {
          errors.push(
            `${name}@${version}: locked version was published at ${publishedAt} and is younger than ${REQUIRED_RELEASE_AGE_SECONDS} seconds`,
          );
        }
      }
    }
  };
  const workerCount = Math.min(MAX_REGISTRY_CONCURRENCY, packages.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { checked: candidates.length, errors: errors.sort() };
};

const run = async () => {
  const baseLockfilePath = process.argv[2];
  const baseBunfigPath = process.argv[3];
  const baseNpmrcPath = process.argv[4];
  if (
    baseLockfilePath === undefined ||
    baseBunfigPath === undefined ||
    baseNpmrcPath === undefined
  ) {
    throw new Error("the trusted base bun.lock, bunfig.toml, and .npmrc paths are required");
  }
  const eventName = process.env.GITHUB_EVENT_NAME ?? "push"; const now = new Date();
  const results: Array<{ checked: number; errors: string[] }> = [];
  if (existsSync(LOCKFILE)) results.push(await checkNewLockedRegistryReleaseAges({
    eventName, now, baseBunfig: existsSync(baseBunfigPath) ? readFileSync(baseBunfigPath, "utf8") : undefined,
    baseLockfile: existsSync(baseLockfilePath) ? readFileSync(baseLockfilePath, "utf8") : undefined,
    baseNpmrcPresent: pathEntryExists(baseNpmrcPath), bunfig: readFileSync(BUNFIG, "utf8"), lockfile: readFileSync(LOCKFILE, "utf8"),
  }));
  if (existsSync("pnpm-lock.yaml")) results.push(await checkNewPnpmReleaseAges({
    eventName, now, workspace: readFileSync("pnpm-workspace.yaml", "utf8"), lockfile: readFileSync("pnpm-lock.yaml", "utf8"),
    baseWorkspace: existsSync(".quarantine-base/pnpm-workspace.yaml") ? readFileSync(".quarantine-base/pnpm-workspace.yaml", "utf8") : undefined,
    baseLockfile: existsSync(".quarantine-base/pnpm-lock.yaml") ? readFileSync(".quarantine-base/pnpm-lock.yaml", "utf8") : undefined,
  }));
  const cargoFiles = spawnSync("git", ["ls-files", "-z", "**/Cargo.lock", "Cargo.lock"], { encoding: "utf8" }).stdout.split("\0").filter(Boolean);
  if (cargoFiles.length) {
    let lastApi = 0;
    const fetchWithRetry = async (url: string, headers: Record<string, string> = {}) => {
      let failure = "unknown registry failure";
      for (let attempt = 0; attempt < MAX_REGISTRY_ATTEMPTS; attempt++) {
        try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) }); if (response.ok) return response; failure = `HTTP ${response.status}`; } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        if (attempt + 1 < MAX_REGISTRY_ATTEMPTS) await Bun.sleep(REGISTRY_RETRY_DELAY_MS * 2 ** attempt);
      }
      throw new Error(failure);
    };
    const quarantine = Bun.TOML.parse(readFileSync(".cargo/quarantine.toml", "utf8")) as { excludes?: string[] };
    results.push(await checkNewCargoReleaseAges({ now, excludes: quarantine.excludes ?? [], lockfiles: new Map(cargoFiles.map((file) => [file, readFileSync(file, "utf8")])), baseLockfiles: new Map(cargoFiles.flatMap((file) => existsSync(`.quarantine-base/${file}`) ? [[file, readFileSync(`.quarantine-base/${file}`, "utf8")] as const] : [])),
      loadIndex: async (_name, indexPath) => (await fetchWithRetry(`https://index.crates.io/${indexPath}`)).text(),
      loadApi: async (name, version) => { const wait = Math.max(0, 1000 - (Date.now() - lastApi)); if (wait) await Bun.sleep(wait); lastApi = Date.now(); return (await fetchWithRetry(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { "User-Agent": "stella-quarantine-policy (https://github.com/stella/.github)" })).json(); },
    }));
  }
  const errors = results.flatMap((result) => result.errors); if (errors.length) throw new Error(errors.join("\n"));
  console.log(`validated ${results.reduce((sum, result) => sum + result.checked, 0)} newly locked registry version(s)`);
};

if (import.meta.main) await run();
