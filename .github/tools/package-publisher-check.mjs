#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const readManifest = async (file) => JSON.parse(await readFile(file, "utf8"));

const globPattern = (pattern) => {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*")}(?:/package\\.json)?$`, "u");
};

const packageFiles = async (root) => {
  const rootFile = resolve(root, "package.json");
  let rootManifest;
  try {
    rootManifest = await readManifest(rootFile);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages ?? [];
  const matchers = patterns.filter((value) => typeof value === "string").map(globPattern);
  const files = [rootFile];
  if (matchers.length === 0) return files;

  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      const child = resolve(directory, entry.name);
      const path = relative(root, child).split(sep).join("/");
      if (matchers.some((matcher) => matcher.test(path))) {
        try {
          await readFile(resolve(child, "package.json"));
          files.push(resolve(child, "package.json"));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      await visit(child);
    }
  };
  await visit(root);
  return files;
};

export const normalizeRepository = (repository) => {
  let value = typeof repository === "string" ? repository : repository?.url;
  if (typeof value !== "string" || value.trim() === "") return null;
  value = value.trim().replace(/^github:/u, "").replace(/^git\+/u, "").replace(/\.git(?:#.*)?$/u, "");
  if (/^[^/:]+\/[^/]+$/u.test(value)) return value;
  value = value.replace(/^git@[^:]+:/u, "https://placeholder/");
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/^\//u, "").split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
};

export async function checkPackagePublishers({ root = ".", repository, registry = DEFAULT_REGISTRY, fetchImpl = fetch }) {
  if (!/^[^/]+\/[^/]+$/u.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/name");
  const manifests = await Promise.all((await packageFiles(resolve(root))).map(readManifest));
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
    if (publishedFrom.toLowerCase() !== repository.toLowerCase()) {
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
