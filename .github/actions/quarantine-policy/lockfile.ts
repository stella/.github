const LOCKFILE = "bun.lock";
const REGISTRY_RESOLUTION =
  /^(?<name>(?:@[^/]+\/)?[^@/]+)@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

export type LockedRegistryVersion = {
  name: string;
  version: string;
};

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
