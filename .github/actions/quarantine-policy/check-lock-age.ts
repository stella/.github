import { existsSync, readFileSync } from "node:fs";
import { readNewLockedRegistryVersions } from "./lockfile";
import {
  exactTimestamp,
  isChangeEvent,
  NPM_REGISTRY,
  pathEntryExists,
  readParsedExcludes,
  REQUIRED_RELEASE_AGE_SECONDS,
} from "./check";

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
type LoadPackageMetadata = (name: string) => Promise<unknown>;

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
  const result = await checkNewLockedRegistryReleaseAges({
    eventName: process.env.GITHUB_EVENT_NAME ?? "push",
    now: new Date(),
    baseBunfig: existsSync(baseBunfigPath)
      ? readFileSync(baseBunfigPath, "utf8")
      : undefined,
    baseLockfile: existsSync(baseLockfilePath)
      ? readFileSync(baseLockfilePath, "utf8")
      : undefined,
    baseNpmrcPresent: pathEntryExists(baseNpmrcPath),
    bunfig: readFileSync(BUNFIG, "utf8"),
    lockfile: readFileSync(LOCKFILE, "utf8"),
  });
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  console.log(`${LOCKFILE}: validated ${result.checked} newly locked registry version(s)`);
};

if (import.meta.main) await run();
