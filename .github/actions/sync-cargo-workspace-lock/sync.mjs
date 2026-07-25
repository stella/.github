import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MODES = new Set(["check", "write"]);

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const packageTable = (manifest, manifestPath) => {
  const headers = [
    ...manifest.matchAll(/^\s*\[package\]\s*(?:#.*)?$/gm),
  ];
  if (headers.length !== 1) {
    throw new Error(
      `${manifestPath} must contain exactly one [package] table; found ${headers.length}`,
    );
  }

  const start = headers[0].index + headers[0][0].length;
  const remainder = manifest.slice(start);
  const nextTable = /^\s*\[+[^\]\r\n]+\]+\s*(?:#.*)?$/m.exec(remainder);
  return nextTable === null
    ? remainder
    : remainder.slice(0, nextTable.index);
};

const inheritsWorkspaceVersion = (table) => {
  if (/^\s*version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(table)) {
    return true;
  }

  const inline = /^\s*version\s*=\s*\{([^}\r\n]*)\}\s*(?:#.*)?$/m.exec(
    table,
  );
  return inline !== null && /(?:^|,)\s*workspace\s*=\s*true\s*(?:,|$)/.test(inline[1]);
};

const assertMetadata = (metadata) => {
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !Array.isArray(metadata.workspace_members) ||
    !Array.isArray(metadata.packages)
  ) {
    throw new Error("cargo metadata returned an invalid workspace document");
  }
};

export const discoverInheritedPackages = (
  metadata,
  readManifest = (path) => readFileSync(path, "utf8"),
) => {
  assertMetadata(metadata);
  const workspaceMembers = new Set(metadata.workspace_members);
  const inherited = [];
  const names = new Set();

  for (const cargoPackage of metadata.packages) {
    if (!workspaceMembers.has(cargoPackage.id)) {
      continue;
    }
    for (const field of ["id", "name", "version", "manifest_path"]) {
      if (typeof cargoPackage[field] !== "string" || cargoPackage[field] === "") {
        throw new Error(`cargo metadata package is missing ${field}`);
      }
    }

    const manifest = readManifest(cargoPackage.manifest_path);
    if (!inheritsWorkspaceVersion(packageTable(manifest, cargoPackage.manifest_path))) {
      continue;
    }
    if (names.has(cargoPackage.name)) {
      throw new Error(
        `inherited workspace package name '${cargoPackage.name}' is not unique`,
      );
    }
    names.add(cargoPackage.name);
    inherited.push({
      name: cargoPackage.name,
      version: cargoPackage.version,
    });
  }

  if (inherited.length === 0) {
    throw new Error("workspace has no packages inheriting workspace.package.version");
  }

  inherited.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return inherited;
};

const normalizedLineEndings = (text, lockfilePath) => {
  const hasCrLf = text.includes("\r\n");
  const withoutCrLf = text.replaceAll("\r\n", "");
  if (withoutCrLf.includes("\r")) {
    throw new Error(`${lockfilePath} contains unsupported bare CR line endings`);
  }
  const hasLf = /(^|[^\r])\n/.test(text);
  if (hasCrLf && hasLf) {
    throw new Error(`${lockfilePath} contains mixed LF and CRLF line endings`);
  }
  return {
    newline: hasCrLf ? "\r\n" : "\n",
    text: hasCrLf ? text.replaceAll("\r\n", "\n") : text,
  };
};

const packageBlocks = (lockText) => {
  const headers = [...lockText.matchAll(/^\[\[package\]\][ \t]*$/gm)];
  return headers.map((header, index) => ({
    start: header.index,
    end: headers[index + 1]?.index ?? lockText.length,
    text: lockText.slice(header.index, headers[index + 1]?.index ?? lockText.length),
  }));
};

const singleField = (block, field, packageName) => {
  const matcher = new RegExp(
    `^([ \\t]*${escapeRegExp(field)}[ \\t]*=[ \\t]*")([^"]+)("[ \\t]*)$`,
    "gm",
  );
  const matches = [...block.text.matchAll(matcher)];
  if (matches.length !== 1) {
    throw new Error(
      `Cargo.lock local package '${packageName}' must contain exactly one ` +
        `${field} field; found ${matches.length}`,
    );
  }
  return matches[0];
};

export const synchronizeLockText = (
  lockText,
  inheritedPackages,
  lockfilePath = "Cargo.lock",
) => {
  const lineEndings = normalizedLineEndings(lockText, lockfilePath);
  const blocks = packageBlocks(lineEndings.text);
  if (blocks.length === 0) {
    throw new Error(`${lockfilePath} has no [[package]] entries`);
  }

  const replacements = [];
  const mismatches = [];
  for (const cargoPackage of inheritedPackages) {
    const packageName = cargoPackage.name;
    const nameMatcher = new RegExp(
      `^[ \\t]*name[ \\t]*=[ \\t]*"${escapeRegExp(packageName)}"[ \\t]*$`,
      "m",
    );
    const localBlocks = blocks.filter(
      (block) =>
        nameMatcher.test(block.text) &&
        !/^[ \t]*source[ \t]*=/m.test(block.text),
    );
    if (localBlocks.length !== 1) {
      throw new Error(
        `${lockfilePath} must contain exactly one local entry for inherited ` +
          `package '${packageName}'; found ${localBlocks.length}`,
      );
    }

    const block = localBlocks[0];
    const version = singleField(block, "version", packageName);
    if (version[2] === cargoPackage.version) {
      continue;
    }
    mismatches.push({
      name: packageName,
      actual: version[2],
      expected: cargoPackage.version,
    });
    const valueOffset = block.start + version.index + version[1].length;
    replacements.push({
      start: valueOffset,
      end: valueOffset + version[2].length,
      value: cargoPackage.version,
    });
  }

  let updated = lineEndings.text;
  replacements.sort((left, right) => right.start - left.start);
  for (const replacement of replacements) {
    updated =
      updated.slice(0, replacement.start) +
      replacement.value +
      updated.slice(replacement.end);
  }
  if (lineEndings.newline === "\r\n") {
    updated = updated.replaceAll("\n", "\r\n");
  }

  return { text: updated, mismatches };
};

const loadCargoMetadata = (manifestPath) => {
  try {
    return JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--manifest-path",
          resolve(manifestPath),
          "--no-deps",
          "--locked",
          "--format-version",
          "1",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    throw new Error(
      `cargo metadata failed for ${manifestPath}${detail ? `: ${detail}` : ""}`,
    );
  }
};

const atomicWrite = (path, text) => {
  const resolvedPath = resolve(path);
  const temporaryPath = `${resolvedPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const mode = statSync(resolvedPath).mode;
  try {
    writeFileSync(temporaryPath, text, { encoding: "utf8", mode });
    renameSync(temporaryPath, resolvedPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

export const synchronizeWorkspace = ({
  mode,
  manifestPath,
  lockfilePath,
  metadata = loadCargoMetadata(manifestPath),
  write = atomicWrite,
}) => {
  if (!MODES.has(mode)) {
    throw new Error(`mode must be 'check' or 'write'; got '${mode}'`);
  }
  const packages = discoverInheritedPackages(metadata);
  const lockText = readFileSync(lockfilePath, "utf8");
  const result = synchronizeLockText(lockText, packages, lockfilePath);
  const changed = result.mismatches.length > 0;

  if (mode === "check" && changed) {
    const details = result.mismatches
      .map(
        ({ name, actual, expected }) =>
          `${name}: Cargo.lock has ${actual}; expected ${expected}`,
      )
      .join("\n");
    throw new Error(`inherited Cargo workspace version drift detected:\n${details}`);
  }
  if (mode === "write" && changed) {
    write(lockfilePath, result.text);
  }

  return {
    changed: mode === "write" && changed,
    mismatches: result.mismatches,
    packages,
  };
};

const parseArgs = (args) => {
  const options = {
    mode: "check",
    manifestPath: "Cargo.toml",
    lockfilePath: "Cargo.lock",
  };
  const names = new Map([
    ["--mode", "mode"],
    ["--manifest", "manifestPath"],
    ["--lockfile", "lockfilePath"],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const field = names.get(flag);
    if (field === undefined) {
      throw new Error(`unknown argument '${flag ?? ""}'`);
    }
    if (seen.has(flag)) {
      throw new Error(`argument '${flag}' was provided more than once`);
    }
    const value = args[index + 1];
    if (value === undefined || value === "") {
      throw new Error(`argument '${flag}' requires a value`);
    }
    seen.add(flag);
    options[field] = value;
  }
  return options;
};

const appendOutputs = (result) => {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${result.changed ? "true" : "false"}\n` +
      `packages=${JSON.stringify(result.packages.map(({ name }) => name))}\n`,
  );
};

const escapeWorkflowCommand = (value) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const main = () => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = synchronizeWorkspace(options);
    appendOutputs(result);
    const packageNames = result.packages.map(({ name }) => name).join(", ");
    console.log(
      result.changed
        ? `Updated ${options.lockfilePath}: ${packageNames}`
        : `Inherited Cargo workspace versions are current: ${packageNames}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${escapeWorkflowCommand(message)}`);
    process.exit(1);
  }
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
