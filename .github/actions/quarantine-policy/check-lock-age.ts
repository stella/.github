import { existsSync, readFileSync } from "node:fs";
import {
  exactTimestamp,
  NPM_REGISTRY,
  readParsedExcludes,
  REQUIRED_RELEASE_AGE_SECONDS,
} from "./check";

const BUNFIG = "bunfig.toml";
const LOCKFILE = "bun.lock";
const MAX_REGISTRY_CONCURRENCY = 8;
const MAX_REGISTRY_ATTEMPTS = 3;
const REGISTRY_RETRY_DELAY_MS = 500;
const REGISTRY_TIMEOUT_MS = 10_000;
const REGISTRY_RESOLUTION =
  /^(?<name>(?:@[^/]+\/)?[^@/]+)@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

export type LockedRegistryVersion = {
  name: string;
  version: string;
};

type LoadPackageMetadata = (name: string) => Promise<unknown>;

const registryKey = ({ name, version }: LockedRegistryVersion): string =>
  `${name}@${version}`;

export const readLockedRegistryVersions = (
  lockfile: string,
): LockedRegistryVersion[] => {
  const parsed: unknown = Bun.JSONC.parse(lockfile);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("packages" in parsed) ||
    typeof parsed.packages !== "object" ||
    parsed.packages === null
  ) {
    throw new Error(`${LOCKFILE} must contain a packages mapping`);
  }
  const versions = new Map<string, LockedRegistryVersion>();
  for (const [key, value] of Object.entries(parsed.packages)) {
    if (!Array.isArray(value)) {
      throw new Error(`${LOCKFILE} package ${key} must contain a resolution`);
    }
    const resolution = value.at(0);
    if (typeof resolution !== "string") {
      throw new Error(`${LOCKFILE} package ${key} must contain a resolution`);
    }
    const parsed = REGISTRY_RESOLUTION.exec(resolution);
    if (parsed?.groups === undefined) continue;
    if (value.at(1) !== "") {
      throw new Error(
        `${LOCKFILE} registry package ${key} must use the canonical registry source`,
      );
    }
    const name = parsed.groups.name;
    const version = parsed.groups.version;
    if (name === undefined || version === undefined) continue;
    const candidate = {
      name,
      version,
    };
    versions.set(registryKey(candidate), candidate);
  }
  return [...versions.values()].sort((left, right) =>
    registryKey(left).localeCompare(registryKey(right)),
  );
};

export const readNewLockedRegistryVersions = ({
  baseExcludes = [],
  baseLockfile,
  lockfile,
}: {
  baseExcludes?: string[];
  baseLockfile?: string;
  lockfile: string;
}): LockedRegistryVersion[] => {
  const base = new Set(
    (baseLockfile === undefined ? [] : readLockedRegistryVersions(baseLockfile)).map(
      registryKey,
    ),
  );
  const excludedAtBase = new Set(baseExcludes);
  return readLockedRegistryVersions(lockfile).filter(
    (candidate) =>
      !base.has(registryKey(candidate)) ||
      excludedAtBase.has(candidate.name) ||
      excludedAtBase.has(registryKey(candidate)),
  );
};

const loadRegistryMetadata: LoadPackageMetadata = async (name) => {
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
  bunfig,
  loadMetadata = loadRegistryMetadata,
  lockfile,
  now = new Date(),
}: {
  baseBunfig?: string;
  baseLockfile?: string;
  baseNpmrcPresent?: boolean;
  bunfig: string;
  loadMetadata?: LoadPackageMetadata;
  lockfile: string;
  now?: Date;
}): Promise<{ checked: number; errors: string[] }> => {
  const excludes = new Set(readParsedExcludes(bunfig));
  const baseExcludes = baseNpmrcPresent ? undefined : readTrustedBaseExcludes(baseBunfig);
  const candidates = readNewLockedRegistryVersions({
    baseExcludes: baseExcludes ?? [],
    baseLockfile: baseExcludes === undefined ? undefined : baseLockfile,
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
  const result = await checkNewLockedRegistryReleaseAges({
    baseBunfig: existsSync(baseBunfigPath)
      ? readFileSync(baseBunfigPath, "utf8")
      : undefined,
    baseLockfile: existsSync(baseLockfilePath)
      ? readFileSync(baseLockfilePath, "utf8")
      : undefined,
    baseNpmrcPresent: existsSync(baseNpmrcPath),
    bunfig: readFileSync(BUNFIG, "utf8"),
    lockfile: readFileSync(LOCKFILE, "utf8"),
  });
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  console.log(`${LOCKFILE}: validated ${result.checked} newly locked registry version(s)`);
};

if (import.meta.main) await run();
