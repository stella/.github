import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkQuarantinePolicy,
  exactTimestamp,
  isChangeEvent,
  pathEntryExists,
  pruneExpiredExcludes,
  REQUIRED_RELEASE_AGE_SECONDS,
  type CheckResult,
} from "./check";
import { readLockedRegistryVersions } from "./lockfile";

export type CargoSource =
  | { kind: "crates-io" }
  | { kind: "path" }
  | { kind: "first-party-git"; repository: string; commit: string }
  | { kind: "unsupported"; source: string };

const CARGO_REGISTRY_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "sparse+https://index.crates.io/",
]);
const FIRST_PARTY_CARGO_GIT_SOURCE =
  /^git\+https:\/\/github\.com\/stella\/(?<repository>[A-Za-z0-9][A-Za-z0-9._-]*)(?:\?(?:rev|tag|branch)=[^#]+)?#(?<commit>[0-9a-f]{40})$/u;

export const classifyCargoSource = (
  name: string,
  source: string | undefined,
): CargoSource => {
  if (source === undefined) return { kind: "path" };
  if (CARGO_REGISTRY_SOURCES.has(source)) return { kind: "crates-io" };
  const match = FIRST_PARTY_CARGO_GIT_SOURCE.exec(source);
  const repository = match?.groups?.repository;
  const commit = match?.groups?.commit;
  if (
    repository !== undefined &&
    commit !== undefined &&
    !repository.toLowerCase().endsWith(".git") &&
    (name.startsWith("stella-") || name.startsWith("stella_"))
  ) {
    return { kind: "first-party-git", repository, commit };
  }
  return { kind: "unsupported", source };
};

const read = (root: string, name: string): string | undefined => {
  const file = path.join(root, name);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

export const readBunRoots = (root: string, input?: string): string[] => {
  const values = (input?.trim() || ".").split(/\s+/u);
  const roots = values.includes(".") ? values : [".", ...values];
  const seen = new Set<string>();
  for (const bunRoot of roots) {
    const segments = bunRoot.split("/");
    if (
      path.posix.isAbsolute(bunRoot) ||
      bunRoot !== path.posix.normalize(bunRoot) ||
      segments.includes("..")
    ) {
      throw new Error(
        `invalid Bun root "${bunRoot}": must be a normalised repository-relative directory without ..`,
      );
    }
    if (seen.has(bunRoot))
      throw new Error(`invalid Bun root "${bunRoot}": roots must be unique`);
    seen.add(bunRoot);
    const directory = path.join(root, bunRoot);
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      throw new Error(
        `invalid Bun root "${bunRoot}": directory does not exist`,
      );
    if (!existsSync(path.join(directory, "bun.lock")))
      throw new Error(`invalid Bun root "${bunRoot}": bun.lock does not exist`);
  }
  return roots;
};

const bunPath = (bunRoot: string, file: string): string =>
  bunRoot === "." ? file : path.posix.join(bunRoot, file);

const tracked = (root: string): string[] => {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
};

type MarkedEntry = {
  annotation: "excluded-since" | "expires";
  line: string;
  name: string;
  timestamp: string;
};

const markedList = (
  source: string,
  key: string,
  file: string,
): { entries: MarkedEntry[]; errors: string[] } => {
  const errors: string[] = [];
  const declaration = new RegExp(
    `^[ \\t]*${key}[ \\t]*[:=][ \\t]*(?:\\[)?`,
    "mu",
  ).exec(source);
  if (declaration === null)
    return { entries: [], errors: [`${file} must declare ${key} as a list`] };
  const bracketed = source
    .slice(declaration.index, declaration.index + declaration[0].length)
    .includes("[");
  const nextTopLevel = source
    .slice(declaration.index + declaration[0].length)
    .search(/^\S/mu);
  const end = bracketed
    ? source.indexOf("]", declaration.index)
    : nextTopLevel < 0
      ? source.length
      : declaration.index + declaration[0].length + nextTopLevel;
  if (end < 0)
    return { entries: [], errors: [`${file} has an unterminated ${key} list`] };
  const entries = source
    .slice(declaration.index, end)
    .split("\n")
    .flatMap((line) => {
      if (!/^\s*(?:-\s*)?"/u.test(line)) return [];
      const match =
        /^\s*(?:-\s*)?"(?<name>[^"]+)"\s*,?\s*#\s*(?<marker>quarantine-expires:|quarantine-excluded-since:)\s*(?<timestamp>\S+)\s*$/u.exec(
          line,
        );
      if (match?.groups === undefined) {
        errors.push(
          `${file} has an unannotated or malformed quarantine exclude: ${line.trim()}`,
        );
        return [];
      }
      return [
        {
          annotation:
            match.groups.marker === "quarantine-expires:"
              ? ("expires" as const)
              : ("excluded-since" as const),
          line,
          name: match.groups.name!,
          timestamp: match.groups.timestamp!,
        },
      ];
    });
  if (new Set(entries.map(({ name }) => name)).size !== entries.length)
    errors.push(`${file} ${key} must not contain duplicates`);
  return { entries, errors };
};

const validateMarkers = ({
  entries,
  file,
  firstParty,
  now,
  inherited,
}: {
  entries: MarkedEntry[];
  file: string;
  firstParty: (name: string) => boolean;
  now: Date;
  inherited: boolean;
}): CheckResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const temporal = (message: string) =>
    (inherited ? warnings : errors).push(message);
  for (const entry of entries) {
    if (!exactTimestamp(entry.timestamp)) {
      errors.push(
        `${file} quarantine exclude "${entry.name}" has an invalid UTC timestamp: ${entry.timestamp}`,
      );
      continue;
    }
    const time = Date.parse(entry.timestamp);
    if (firstParty(entry.name)) {
      if (entry.annotation !== "excluded-since")
        errors.push(
          `${file} first-party quarantine exclude "${entry.name}" must use quarantine-excluded-since:`,
        );
      else if (time > now.getTime())
        temporal(
          `${file} first-party quarantine exclude "${entry.name}" has a future exclusion date`,
        );
    } else if (entry.annotation !== "expires") {
      errors.push(
        `${file} third-party quarantine exclude "${entry.name}" must use quarantine-expires:`,
      );
    } else if (time <= now.getTime()) {
      warnings.push(
        `${file} temporary quarantine exclude "${entry.name}" expired at ${entry.timestamp} and is still present`,
      );
    } else if (time > now.getTime() + REQUIRED_RELEASE_AGE_SECONDS * 1000) {
      temporal(
        `${file} temporary quarantine exclude "${entry.name}" expires more than ${REQUIRED_RELEASE_AGE_SECONDS} seconds after the policy clock`,
      );
    }
  }
  return { errors, warnings };
};

export const readPnpmLockedRegistryVersions = (
  lockfile: string,
  excludes: string[] = [],
) => {
  const parsed = Bun.YAML.parse(lockfile) as {
    packages?: Record<string, unknown>;
  };
  const results = new Map<string, { name: string; version: string }>();
  const excluded = new Set(excludes);
  for (const key of Object.keys(parsed.packages ?? {})) {
    const separator = key.startsWith("@")
      ? key.indexOf("@", key.indexOf("/") + 1)
      : key.indexOf("@");
    if (separator < 1) {
      throw new Error(
        `pnpm-lock.yaml package ${key} uses a non-registry resolution`,
      );
    }
    const name = key.slice(0, separator);
    const resolution = key.slice(separator + 1);
    if (/^(?:link:|file:|workspace:)/u.test(resolution)) continue;
    if (excluded.has(`${name}@${resolution}`)) continue;
    const version = resolution.replace(/\(.+$/u, "");
    if (
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
    ) {
      throw new Error(
        `pnpm-lock.yaml package ${key} uses a non-registry resolution`,
      );
    }
    results.set(`${name}@${version}`, { name, version });
  }
  return [...results.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
};

export const checkPnpmPolicy = ({
  workspace,
  lockfile,
  packageJson,
  npmrc,
  baseWorkspace,
  eventName = "push",
  now,
}: {
  workspace: string;
  lockfile: string;
  packageJson: string;
  npmrc?: string;
  baseWorkspace?: string;
  eventName?: string;
  now: Date;
}): CheckResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = Bun.YAML.parse(workspace) as Record<string, unknown>;
  if (parsed.minimumReleaseAge !== 7200)
    errors.push("pnpm-workspace.yaml must set minimumReleaseAge: 7200");
  if (!Array.isArray(parsed.minimumReleaseAgeExclude))
    errors.push(
      "pnpm-workspace.yaml must declare minimumReleaseAgeExclude as a list",
    );
  if (workspace.match(/^\s*dangerouslyAllowAllBuilds:\s*true\s*$/mu))
    errors.push(
      "pnpm-workspace.yaml must not enable dangerouslyAllowAllBuilds",
    );
  const marked = markedList(
    workspace,
    "minimumReleaseAgeExclude",
    "pnpm-workspace.yaml",
  );
  errors.push(...marked.errors);
  const parsedExcludes = Array.isArray(parsed.minimumReleaseAgeExclude)
    ? parsed.minimumReleaseAgeExclude
    : [];
  const declared = marked.entries.map(({ name }) => name);
  if (
    parsedExcludes.some((value) => typeof value !== "string") ||
    parsedExcludes.length !== declared.length ||
    parsedExcludes.some(
      (value) => typeof value !== "string" || !declared.includes(value),
    ) ||
    declared.some((value) => !parsedExcludes.includes(value))
  ) {
    errors.push(
      "pnpm-workspace.yaml must declare one annotated package per line",
    );
  }
  const inherited = isChangeEvent(eventName) && baseWorkspace === workspace;
  const markers = validateMarkers({
    entries: marked.entries,
    file: "pnpm-workspace.yaml",
    firstParty: (name) => name.startsWith("@stll/"),
    now,
    inherited,
  });
  errors.push(...markers.errors);
  warnings.push(...markers.warnings);
  const manager = (JSON.parse(packageJson) as Record<string, unknown>)
    .packageManager;
  const version =
    typeof manager === "string"
      ? /^pnpm@(\d+)\.(\d+)\.(\d+)$/u.exec(manager)
      : null;
  if (
    version === null ||
    Number(version[1]) < 10 ||
    (Number(version[1]) === 10 && Number(version[2]) < 16)
  )
    errors.push("package.json packageManager must pin pnpm >= 10.16.0");
  if (
    npmrc
      ?.split("\n")
      .some(
        (line) =>
          /^\s*registry\s*=/u.test(line) &&
          !line.includes("https://registry.npmjs.org"),
      )
  )
    errors.push(".npmrc must not configure a non-default registry");
  const locked = new Set(
    readPnpmLockedRegistryVersions(lockfile, declared).map(({ name }) => name),
  );
  if (
    parsed.onlyBuiltDependencies !== undefined &&
    !Array.isArray(parsed.onlyBuiltDependencies)
  )
    errors.push("pnpm-workspace.yaml onlyBuiltDependencies must be a list");
  for (const name of Array.isArray(parsed.onlyBuiltDependencies)
    ? parsed.onlyBuiltDependencies
    : []) {
    if (typeof name !== "string" || !locked.has(name))
      errors.push(
        `pnpm-workspace.yaml onlyBuiltDependencies contains missing package: ${String(name)}`,
      );
  }
  return { errors, warnings };
};

export const readCargoPackages = (lockfile: string) => {
  const parsed = Bun.TOML.parse(lockfile) as {
    package?: Array<Record<string, unknown>>;
  };
  return (parsed.package ?? []).map((item) => ({
    name: String(item.name),
    version: String(item.version),
    source: typeof item.source === "string" ? item.source : undefined,
  }));
};

export const checkCargoPolicy = ({
  quarantine,
  config,
  lockfiles,
  baseQuarantine,
  eventName = "push",
  now,
}: {
  quarantine: string;
  config: string;
  lockfiles: Map<string, string>;
  baseQuarantine?: string;
  eventName?: string;
  now: Date;
}): CheckResult => {
  const marked = markedList(quarantine, "excludes", ".cargo/quarantine.toml");
  const errors = [...marked.errors];
  const warnings: string[] = [];
  const parsedQuarantine = Bun.TOML.parse(quarantine) as { excludes?: unknown };
  const parsedExcludes = Array.isArray(parsedQuarantine.excludes)
    ? parsedQuarantine.excludes
    : [];
  const declared = marked.entries.map(({ name }) => name);
  if (
    parsedExcludes.some((value) => typeof value !== "string") ||
    parsedExcludes.length !== declared.length ||
    parsedExcludes.some(
      (value) => typeof value !== "string" || !declared.includes(value),
    ) ||
    declared.some((value) => !parsedExcludes.includes(value))
  ) {
    errors.push(
      ".cargo/quarantine.toml must declare one annotated package per line",
    );
  }
  const markerResult = validateMarkers({
    entries: marked.entries,
    file: ".cargo/quarantine.toml",
    firstParty: (name) =>
      name.startsWith("stella-") || name.startsWith("stella_"),
    now,
    inherited: isChangeEvent(eventName) && quarantine === baseQuarantine,
  });
  errors.push(...markerResult.errors);
  warnings.push(...markerResult.warnings);
  const excludes = new Set(marked.entries.map(({ name }) => name));
  const seen = new Set<string>();
  for (const [file, contents] of lockfiles)
    for (const pkg of readCargoPackages(contents)) {
      const key = `${pkg.name}@${pkg.version}`;
      seen.add(key);
      const source = classifyCargoSource(pkg.name, pkg.source);
      if (source.kind === "unsupported" && !excludes.has(key))
        errors.push(`${file} ${key} uses unsupported source ${source.source}`);
    }
  for (const entry of marked.entries) {
    const firstParty =
      entry.name.startsWith("stella-") || entry.name.startsWith("stella_");
    if (!firstParty && !/^[^@]+@[^@]+$/u.test(entry.name))
      errors.push(
        `.cargo/quarantine.toml third-party exclude "${entry.name}" must use name@version`,
      );
    if (!firstParty && !seen.has(entry.name))
      errors.push(
        `.cargo/quarantine.toml contains stale exclude: ${entry.name}`,
      );
  }
  const parsedConfig = Bun.TOML.parse(config) as {
    registry?: Record<string, unknown>;
  };
  if (parsedConfig.registry?.["global-min-publish-age"] !== "5 days")
    errors.push(
      '.cargo/config.toml must set [registry] global-min-publish-age = "5 days"',
    );
  return { errors, warnings };
};

export const checkBunTrustedDependencies = (
  packageJson: string,
  lockfile: string,
  file = "package.json",
): string[] => {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>;
  if (
    !Array.isArray(parsed.trustedDependencies) ||
    parsed.trustedDependencies.some((v) => typeof v !== "string")
  )
    return [`${file} must declare trustedDependencies as an array of strings`];
  const values = parsed.trustedDependencies as string[];
  const errors: string[] = [];
  if (new Set(values).size !== values.length)
    errors.push(`${file} trustedDependencies must not contain duplicates`);
  const locked = new Set(
    readLockedRegistryVersions(lockfile).map(({ name }) => name),
  );
  for (const name of values)
    if (!locked.has(name))
      errors.push(
        `${file} trustedDependencies contains missing package: ${name}`,
      );
  return errors;
};

export const checkRepositoryPolicy = ({
  root,
  bunRoots,
  eventName,
  now,
}: {
  root: string;
  bunRoots?: string[];
  eventName: string;
  now: Date;
}): CheckResult => {
  const files = tracked(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  const unsupported = files.filter((file) =>
    /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/u.test(file),
  );
  if (unsupported.length)
    errors.push(`unsupported lockfiles: ${unsupported.join(", ")}`);
  const cargoLocks = files.filter((file) => /(^|\/)Cargo\.lock$/u.test(file));
  const effectiveBunRoots =
    bunRoots ?? (files.includes("bun.lock") ? ["."] : []);
  const bun = effectiveBunRoots.length > 0;
  const pnpm = files.includes("pnpm-lock.yaml");
  if (
    !bun &&
    !pnpm &&
    cargoLocks.length === 0 &&
    files.some((file) => /(^|\/)(?:package\.json|Cargo\.toml)$/u.test(file))
  )
    errors.push("unlocked package manifest cannot be screened");
  const baseRoot = path.join(root, ".quarantine-base");
  for (const bunRoot of effectiveBunRoots) {
    const bunfigPath = bunPath(bunRoot, "bunfig.toml");
    const lockfilePath = bunPath(bunRoot, "bun.lock");
    const packageJsonPath = bunPath(bunRoot, "package.json");
    const bunfig = read(root, bunfigPath);
    const lockfile = read(root, lockfilePath)!;
    const packageJson = read(root, packageJsonPath);
    if (bunfig === undefined)
      errors.push(`${bunfigPath} is required for ${lockfilePath}`);
    else {
      const result = checkQuarantinePolicy({
        bunfig,
        lockfile,
        now,
        eventName,
        bunfigPath,
        baseBunfig: read(baseRoot, bunfigPath),
        baseLockfile: read(baseRoot, lockfilePath),
        npmrcPresent: pathEntryExists(path.join(root, ".npmrc")),
        baseNpmrcPresent: pathEntryExists(path.join(baseRoot, ".npmrc")),
      });
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
    if (packageJson === undefined)
      errors.push(`${packageJsonPath} is required for ${lockfilePath}`);
    else
      errors.push(
        ...checkBunTrustedDependencies(packageJson, lockfile, packageJsonPath),
      );
  }
  if (pnpm) {
    const workspace = read(root, "pnpm-workspace.yaml");
    const packageJson = read(root, "package.json");
    if (workspace === undefined || packageJson === undefined)
      errors.push(
        "pnpm-workspace.yaml and package.json are required for pnpm-lock.yaml",
      );
    else {
      const result = checkPnpmPolicy({
        workspace,
        lockfile: read(root, "pnpm-lock.yaml")!,
        packageJson,
        npmrc: read(root, ".npmrc"),
        baseWorkspace: read(baseRoot, "pnpm-workspace.yaml"),
        eventName,
        now,
      });
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
  }
  if (cargoLocks.length) {
    const quarantine = read(root, ".cargo/quarantine.toml");
    const config = read(root, ".cargo/config.toml");
    if (quarantine === undefined || config === undefined)
      errors.push(
        ".cargo/quarantine.toml and .cargo/config.toml are required when Cargo.lock is tracked",
      );
    else {
      const result = checkCargoPolicy({
        quarantine,
        config,
        lockfiles: new Map(cargoLocks.map((file) => [file, read(root, file)!])),
        baseQuarantine: read(baseRoot, ".cargo/quarantine.toml"),
        eventName,
        now,
      });
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
  }
  return { errors, warnings };
};

export const pruneRepositoryExcludes = ({
  root,
  bunRoots = ["."],
  now,
}: {
  root: string;
  bunRoots?: string[];
  now: Date;
}): number => {
  let count = 0;
  for (const [file, key] of [
    ...bunRoots.map(
      (bunRoot) =>
        [bunPath(bunRoot, "bunfig.toml"), "minimumReleaseAgeExcludes"] as const,
    ),
    ["pnpm-workspace.yaml", "minimumReleaseAgeExclude"],
    [".cargo/quarantine.toml", "excludes"],
  ] as const) {
    const source = read(root, file);
    if (source === undefined) continue;
    if (file.endsWith("bunfig.toml")) {
      const result = pruneExpiredExcludes({ bunfig: source, now });
      if (result.pruned.length)
        writeFileSync(path.join(root, file), result.bunfig);
      count += result.pruned.length;
      continue;
    }
    const marked = markedList(source, key, file);
    const expired = marked.entries.filter(
      (entry) =>
        entry.annotation === "expires" &&
        exactTimestamp(entry.timestamp) &&
        Date.parse(entry.timestamp) <= now.getTime(),
    );
    const expiredLines = new Set(expired.map(({ line }) => line));
    if (expired.length > 0) {
      writeFileSync(
        path.join(root, file),
        source
          .split("\n")
          .filter((line) => !expiredLines.has(line))
          .join("\n"),
      );
    }
    count += expired.length;
  }
  return count;
};
