#!/usr/bin/env node

import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const readManifest = async (file) => JSON.parse(await readFile(file, "utf8"));

const manifestPattern = (pattern) => `${pattern.replace(/^\.\//u, "").replace(/\/$/u, "")}/package.json`;

const parsePnpmWorkspace = (source, file) => {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages\s*:\s*(?:#.*)?$/u.test(line));
  if (start === -1) {
    if (lines.some((line) => /^packages\s*:/u.test(line))) {
      throw new Error(`cannot read ${file}: packages must be a plain YAML list`);
    }
    return [];
  }
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const match = line.match(/^\s+-\s+(.+?)\s*$/u);
    if (!match) throw new Error(`cannot read ${file}: packages must be a plain YAML list`);
    const value = match[1];
    let pattern;
    if (value.startsWith('"')) {
      try { pattern = JSON.parse(value); } catch { throw new Error(`cannot read ${file}: invalid quoted package pattern`); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error(`cannot read ${file}: invalid quoted package pattern`);
      pattern = value.slice(1, -1).replace(/''/gu, "'");
    } else {
      pattern = value.replace(/\s+#.*$/u, "").trim();
      if (/^(?:[\[{&*|>@`]|!!)|:\s/u.test(pattern.replace(/^!/u, ""))) {
        throw new Error(`cannot read ${file}: unsupported YAML package pattern`);
      }
    }
    if (typeof pattern !== "string" || pattern === "") throw new Error(`cannot read ${file}: invalid package pattern`);
    patterns.push(pattern);
  }
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
