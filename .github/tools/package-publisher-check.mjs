#!/usr/bin/env node

import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const readManifest = async (file) => JSON.parse(await readFile(file, "utf8"));

const manifestPattern = (pattern) => `${pattern.replace(/^\.\//u, "").replace(/\/$/u, "")}/package.json`;

const workspaceError = (file, line, detail = "packages must be a YAML sequence of strings") =>
  new Error(`cannot read ${file}:${line}: ${detail}`);

const stripYamlComments = (source) => {
  let result = "";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"' && character === "\\") {
      result += character + (source[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === quote) {
      if (quote === "'" && source[index + 1] === "'") {
        result += "''";
        index += 1;
      } else {
        quote = null;
        result += character;
      }
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
      result += character;
      continue;
    }
    if (quote === null && character === "#" && (index === 0 || /\s/u.test(source[index - 1]))) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    result += character;
  }
  return result;
};

const parseWorkspaceScalar = (source, file, line) => {
  const value = source.trim();
  if (value.startsWith('"')) {
    try {
      const match = value.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/u);
      if (!match) throw new Error();
      return JSON.parse(match[1]);
    } catch {
      throw workspaceError(file, line, "invalid quoted package pattern");
    }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'(?:\s+#.*)?$/u);
    if (!match) throw workspaceError(file, line, "invalid quoted package pattern");
    return match[1].replace(/''/gu, "'");
  }

  const pattern = value.replace(/\s+#.*$/u, "").trim();
  if (pattern === "" || /^(?:[\[{&*|>@`]|!!)|:\s/u.test(pattern.replace(/^!/u, ""))) {
    throw workspaceError(file, line, "unsupported YAML package pattern");
  }
  return pattern;
};

const parseFlowSequence = (source, file, startLine) => {
  const patterns = [];
  let item = "";
  let quote = null;
  let closed = false;
  for (let index = 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"' && character === "\\") {
      item += character + (source[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === quote) {
      if (quote === "'" && source[index + 1] === "'") {
        item += "''";
        index += 1;
      } else quote = null;
      item += character;
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
      item += character;
      continue;
    }
    if (quote === null && character === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      item += " ";
      continue;
    }
    if (quote === null && (character === "," || character === "]")) {
      const line = startLine + source.slice(0, index).split("\n").length - 1;
      if (item.trim() !== "") patterns.push(parseWorkspaceScalar(item, file, line));
      else if (character === ",") throw workspaceError(file, line);
      item = "";
      if (character === "]") {
        if (!/^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/u.test(source.slice(index + 1))) throw workspaceError(file, line);
        closed = true;
        break;
      }
      continue;
    }
    item += character;
  }
  if (!closed || quote !== null) throw workspaceError(file, startLine + source.split("\n").length - 1);
  return patterns;
};

const WORKSPACE_KEYS = new Set([
  "catalog", "catalogs", "onlyBuiltDependencies", "ignoredBuiltDependencies", "neverBuiltDependencies",
  "onlyBuiltDependenciesFile", "overrides", "packageExtensions", "peerDependencyRules", "patchedDependencies",
  "supportedArchitectures", "injectWorkspacePackages", "hoistPattern", "publicHoistPattern", "linkWorkspacePackages",
  "sharedWorkspaceLockfile", "saveWorkspaceProtocol", "preferWorkspacePackages", "preferFrozenLockfile",
  "strictPeerDependencies", "autoInstallPeers", "excludeLinksFromLockfile",
]);

const topLevelEntry = (line) => {
  const match = line.match(/^(?:([A-Za-z][A-Za-z0-9]*)|'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)")\s*:(.*)$/u);
  if (!match) return null;
  let key = match[1] ?? match[2]?.replace(/''/gu, "'");
  if (key === undefined) {
    try { key = JSON.parse(`"${match[3]}"`); } catch { return null; }
  }
  return { key, value: match[4].trim() };
};

const parsePnpmWorkspace = (source, file) => {
  const lines = stripYamlComments(source).split(/\r?\n/u);
  const patterns = [];
  let sawPackages = false;
  let index = 0;

  for (const [lineIndex, line] of lines.entries()) {
    if (/^(?:---|\.\.\.)(?:\s|$)/u.test(line)
      || /(?:^|[\s[{,:-])(?:&|\*)[A-Za-z0-9_-]+(?:\s|$|[\]},])/u.test(line)
      || /(?:^|[\s[{,:-])![A-Za-z][A-Za-z0-9_-]*(?:\s|$)/u.test(line)
      || /(?:^|:\s*|-\s+)[|>][+-]?(?:\s|$)/u.test(line)) {
      throw workspaceError(file, lineIndex + 1, "unsupported YAML construct");
    }
  }

  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/u.test(line)) { index += 1; continue; }

    if (line.trimStart().startsWith("{")) {
      const match = lines.slice(index).join("\n").match(/^\s*\{\s*(?:packages|'packages'|"packages")\s*:\s*(\[[\s\S]*)\}\s*(?:#.*)?\s*$/u);
      if (!match) throw workspaceError(file, index + 1, "unsupported top-level flow mapping");
      const sequence = match[1].replace(/\}\s*(?:#.*)?\s*$/u, "");
      const values = parseFlowSequence(sequence, file, index + 1);
      if (values.length === 0) throw workspaceError(file, index + 1, "packages must contain at least one pattern");
      return values;
    }

    const entry = topLevelEntry(line);
    if (!entry) throw workspaceError(file, index + 1, "unrecognised YAML line");
    if (entry.key !== "packages" && !WORKSPACE_KEYS.has(entry.key)) {
      throw workspaceError(file, index + 1, `unsupported top-level key ${entry.key}`);
    }

    if (entry.key !== "packages") {
      index += 1;
      while (index < lines.length && (lines[index].startsWith(" ") || lines[index].startsWith("\t")
        || /^\s*(?:#.*)?$/u.test(lines[index]) || /^-\s/u.test(lines[index]))) index += 1;
      continue;
    }

    if (sawPackages) throw workspaceError(file, index + 1, "duplicate packages key");
    sawPackages = true;
    const value = entry.value.replace(/\s+#.*$/u, "").trim();
    if (value !== "") {
      if (!value.startsWith("[")) throw workspaceError(file, index + 1);
      const values = parseFlowSequence([value, ...lines.slice(index + 1)].join("\n"), file, index + 1);
      patterns.push(...values);
      const consumed = [value, ...lines.slice(index + 1)].join("\n").match(/^[\s\S]*?\](?:[ \t]*(?:#[^\r\n]*)?)?(?:\r?\n|$)/u)?.[0];
      const consumedLines = consumed === undefined ? 1 : consumed.split("\n").length - (consumed.endsWith("\n") ? 1 : 0);
      index += Math.max(1, consumedLines);
      continue;
    }

    index += 1;
    while (index < lines.length) {
      const itemLine = lines[index];
      if (/^\s*(?:#.*)?$/u.test(itemLine)) { index += 1; continue; }
      if (topLevelEntry(itemLine)) break;
      const item = itemLine.match(/^\s*-\s+(.+?)\s*$/u);
      if (!item) throw workspaceError(file, index + 1);
      patterns.push(parseWorkspaceScalar(item[1], file, index + 1));
      index += 1;
    }
  }

  if (!sawPackages) throw workspaceError(file, 1, "missing packages key");
  if (patterns.length === 0) throw workspaceError(file, 1, "packages must contain at least one pattern");
  return patterns;
};

const pnpmWorkspacePatterns = async (root) => {
  const file = resolve(root, "pnpm-workspace.yaml");
  try {
    return parsePnpmWorkspace(await readFile(file, "utf8"), file);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    if (error instanceof Error && error.message.startsWith("cannot read ")) throw error;
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
};

const discoverPackageFiles = async (root) => {
  const rootFile = resolve(root, "package.json");
  let rootManifest;
  try {
    rootManifest = await readManifest(rootFile);
  } catch (error) {
    if (error?.code === "ENOENT") rootManifest = null;
    else throw error;
  }

  const npmPatterns = Array.isArray(rootManifest?.workspaces)
    ? rootManifest.workspaces
    : rootManifest?.workspaces?.packages ?? [];
  const workspacePatterns = [
    ...npmPatterns.filter((value) => typeof value === "string"),
    ...await pnpmWorkspacePatterns(root),
  ];
  const files = rootManifest === null ? [] : [rootFile];
  const included = workspacePatterns.filter((pattern) => !pattern.startsWith("!"));
  if (included.length === 0) return files;

  const excluded = workspacePatterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => manifestPattern(pattern.slice(1)));
  for await (const file of glob(included.map(manifestPattern), {
    cwd: root,
    exclude: ["**/node_modules/**", "**/.git/**", ...excluded],
  })) files.push(resolve(root, file));
  return [...new Set(files)];
};

export const normalizeRepository = (repository) => {
  let value = typeof repository === "string" ? repository : repository?.url;
  if (typeof value !== "string" || value.trim() === "") return null;
  value = value.trim().replace(/^git\+/u, "").replace(/\.git(?:#.*)?$/u, "");
  if (value.startsWith("github:")) value = value.replace(/^github:/u, "https://github.com/");
  if (/^[^/:]+\/[^/]+$/u.test(value)) value = `https://github.com/${value}`;
  value = value.replace(/^git@([^:]+):/u, "https://$1/");
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/^\//u, "").split("/").filter(Boolean);
    return parts.length >= 2 ? `${url.hostname}/${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
};

export async function checkPackagePublishers({ root = ".", packageFiles, repository, registry = DEFAULT_REGISTRY, fetchImpl = fetch }) {
  if (!/^[^/]+\/[^/]+$/u.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/name");
  const absoluteRoot = resolve(root);
  const files = packageFiles === undefined
    ? await discoverPackageFiles(absoluteRoot)
    : packageFiles.map((file) => resolve(absoluteRoot, file));
  const manifests = await Promise.all(files.map(readManifest));
  const names = [...new Set(manifests.map(({ name }) => name).filter((name) => typeof name === "string" && name !== ""))];
  const cache = new Map();

  for (const name of names) {
    let request = cache.get(name);
    if (!request) {
      request = fetchImpl(`${registry.replace(/\/$/u, "")}/${encodeURIComponent(name)}`);
      cache.set(name, request);
    }
    let response;
    try {
      response = await request;
    } catch (error) {
      throw new Error(`failed to read npm registry for ${name}: ${error.message}`, { cause: error });
    }
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`failed to read npm registry for ${name}: HTTP ${response.status}`);

    let document;
    try {
      document = await response.json();
    } catch (error) {
      throw new Error(`failed to read npm registry for ${name}: invalid JSON`, { cause: error });
    }
    const latest = document?.["dist-tags"]?.latest;
    const publishedFrom = normalizeRepository(document?.versions?.[latest]?.repository);
    if (!publishedFrom) throw new Error(`failed to read npm registry for ${name}: latest version has no valid repository.url`);
    if (publishedFrom.toLowerCase() !== `github.com/${repository}`.toLowerCase()) {
      throw new Error(`package ${name} is published from ${publishedFrom}; consume it instead of keeping a copy`);
    }
  }
}

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  await checkPackagePublishers({
    root: option("--root", "."),
    packageFiles: option("--package-files")?.split(/\r?\n/u).map((file) => file.trim()).filter(Boolean),
    repository: option("--repository", process.env.GITHUB_REPOSITORY),
    registry: option("--registry", process.env.NPM_REGISTRY_URL ?? DEFAULT_REGISTRY),
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
