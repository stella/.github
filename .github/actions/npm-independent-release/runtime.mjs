import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

import {
  artifactReleaseName,
  changelogSection,
  createPlan,
  hashBuffer,
  indexReleases,
  lines,
  mapArtifacts,
  readPackages,
  releaseNotes,
  sha256File,
  validateDistTag,
} from "./state.mjs";

const MAX_BUFFER = 512 * 1024 * 1024;
const STAGING_RECHECK_DELAYS_MILLISECONDS = [
  1_000, 2_000, 4_000, 8_000, 15_000,
];
const GITHUB_LATEST_POLICIES = new Set([
  "preserve",
  "newest-published-stable",
]);

const fail = (message) => {
  throw new Error(message);
};

export const resolveSourceSha = ({ githubSha, sourceSha }) => {
  const resolved = sourceSha || githubSha;
  if (!/^[0-9a-f]{40}$/.test(resolved ?? "")) {
    fail("SOURCE_SHA or GITHUB_SHA must be a full lowercase commit SHA.");
  }
  return resolved;
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();

const attempt = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const isNotFound = (result) =>
  /(?:HTTP 404|E404|404 Not Found)/.test(result.stderr ?? "");

const apiPath = (value) => encodeURIComponent(value);

const githubJson = (endpoint) => {
  const result = attempt("gh", ["api", endpoint]);
  if (result.status === 0) return JSON.parse(result.stdout);
  if (isNotFound(result)) return null;
  fail(`GitHub API request failed for ${endpoint}: ${result.stderr.trim()}`);
};

const githubJsonPages = (endpoint) => {
  const result = attempt("gh", ["api", "--paginate", "--slurp", endpoint]);
  if (result.status === 0) return JSON.parse(result.stdout);
  fail(`GitHub API request failed for ${endpoint}: ${result.stderr.trim()}`);
};

const tagTarget = (repository, tag) => {
  let ref = githubJson(`repos/${repository}/git/ref/tags/${apiPath(tag)}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object.type === "tag" && depth < 4; depth += 1) {
    const annotated = githubJson(`repos/${repository}/git/tags/${object.sha}`);
    if (!annotated) fail(`Annotated tag object ${object.sha} disappeared.`);
    object = annotated.object;
  }
  if (object.type !== "commit")
    fail(`Tag ${tag} does not resolve to a commit.`);
  return object.sha;
};

const npmState = (name, version) => {
  const spec = `${name}@${version}`;
  const result = attempt("npm", [
    "view",
    spec,
    "version",
    "dist.integrity",
    "dist.tarball",
    "--json",
  ]);
  if (result.status !== 0) {
    if (isNotFound(result))
      return { exists: false, integrity: null, tarball: null };
    fail(`npm registry lookup failed for ${spec}: ${result.stderr.trim()}`);
  }
  const metadata = JSON.parse(result.stdout);
  if (metadata.version !== version) {
    fail(`npm returned '${metadata.version}' for ${spec}.`);
  }
  return {
    exists: true,
    integrity: metadata["dist.integrity"] ?? metadata.dist?.integrity ?? null,
    tarball: metadata["dist.tarball"] ?? metadata.dist?.tarball ?? null,
  };
};

const releaseAssetIntegrity = (repository, release) => {
  if (!release || release.assets.length !== 1) return null;
  const [{ id }] = release.assets;
  const result = attempt(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${repository}/releases/assets/${id}`,
    ],
    { encoding: null },
  );
  if (result.status !== 0) {
    fail(
      `Could not download GitHub release asset ${id}: ${result.stderr.toString().trim()}`,
    );
  }
  return hashBuffer("sha512", result.stdout);
};

const tarballsWithin = (root) => {
  const found = [];
  const visit = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (entry.endsWith(".tgz")) found.push(path);
    }
  };
  visit(root);
  return found;
};

export const listTarballs = (directory, expectedArtifacts) => {
  // download-artifact extracts one matching artifact directly into `path`, but
  // preserves one top-level directory per artifact when several match.
  const entries = readdirSync(directory).sort();
  if (
    expectedArtifacts > 1 &&
    entries.some((entry) => !statSync(join(directory, entry)).isDirectory())
  ) {
    fail(
      `Expected ${expectedArtifacts} package artifacts in separate directories; downloaded a flat artifact layout.`,
    );
  }
  const artifactDirectories =
    expectedArtifacts === 1
      ? [directory]
      : entries
          .map((entry) => join(directory, entry))
          .filter((path) => statSync(path).isDirectory());
  if (artifactDirectories.length !== expectedArtifacts) {
    fail(
      `Expected ${expectedArtifacts} package artifacts; downloaded ${artifactDirectories.length}.`,
    );
  }
  const results = [];
  for (const artifactDirectory of artifactDirectories) {
    const found = tarballsWithin(artifactDirectory);
    if (found.length !== 1) {
      fail(
        `${basename(artifactDirectory)} must contain exactly one .tgz; found ${found.length}.`,
      );
    }
    results.push(found[0]);
  }
  return results;
};

const readArtifact = (path) => {
  let manifestText;
  try {
    manifestText = run("tar", ["-xOf", path, "package/package.json"]);
  } catch {
    fail(`${path} does not contain package/package.json.`);
  }
  return {
    path,
    manifest: JSON.parse(manifestText),
    integrity: hashBuffer("sha512", readFileSync(path)),
    sha256: sha256File(path),
  };
};

const remoteState = ({
  head,
  localIntegrity,
  pkg,
  releasesByTag,
  repository,
}) => {
  const tag = `${pkg.name}@${pkg.version}`;
  const registry = npmState(pkg.name, pkg.version);
  const release = releasesByTag.get(tag) ?? null;
  return {
    head,
    registry,
    release,
    tagTarget: tagTarget(repository, tag),
    assetIntegrity: releaseAssetIntegrity(repository, release),
    localIntegrity,
  };
};

const appendOutput = (name, value) => {
  const delimiter = `release_${randomUUID()}`;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
};

const createTag = (repository, tag, head) => {
  run("gh", [
    "api",
    "--method",
    "POST",
    `repos/${repository}/git/refs`,
    "-f",
    `ref=refs/tags/${tag}`,
    "-f",
    `sha=${head}`,
  ]);
};

const registryAsset = async ({ entry, temporaryDirectory }) => {
  const url = new URL(entry.registry.tarball ?? "");
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    fail(
      `npm returned an unexpected tarball URL for ${entry.pkg.name}: ${url.href}`,
    );
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok)
    fail(
      `Could not recover ${entry.pkg.name} from npm: HTTP ${response.status}.`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = hashBuffer("sha512", bytes);
  if (integrity !== entry.registry.integrity) {
    fail(
      `Recovered npm tarball for ${entry.pkg.name} failed its integrity check.`,
    );
  }
  mkdirSync(temporaryDirectory, { recursive: true });
  const path = join(temporaryDirectory, artifactReleaseName(entry.path));
  writeFileSync(path, bytes);
  return path;
};

const notesFor = (entry) => {
  const section = changelogSection(
    readFileSync(entry.pkg.changelog, "utf8"),
    entry.pkg.version,
    entry.pkg.changelog,
  );
  return releaseNotes({ pkg: entry.pkg, section, status: entry.status });
};

export const buildCreateReleaseArgs = ({
  asset,
  notesPath,
  packageVersion,
  repository,
  tag,
}) => {
  const args = [
    "release",
    "create",
    tag,
    asset,
    "--repo",
    repository,
    "--draft",
    "--latest=false",
    "--title",
    tag,
    "--notes-file",
    notesPath,
    "--verify-tag",
  ];
  if (packageVersion.includes("-")) args.push("--prerelease");
  return args;
};

export const buildPublishReleaseArgs = ({ repository, tag }) => [
  "release",
  "edit",
  tag,
  "--repo",
  repository,
  "--draft=false",
  "--latest=false",
];

export const buildMarkLatestArgs = ({ repository, tag }) => [
  "release",
  "edit",
  tag,
  "--repo",
  repository,
  "--latest=true",
];

export const validateGithubLatestPolicy = (policy) => {
  if (!GITHUB_LATEST_POLICIES.has(policy)) {
    fail(`Invalid GitHub Latest policy '${policy}'.`);
  }
  return policy;
};

export const selectLatestReleaseEntry = ({ entries, head, policy }) => {
  validateGithubLatestPolicy(policy);
  if (policy === "preserve") return null;
  return (
    entries
      .filter(
        (entry) =>
          entry.tagTarget === head && !entry.pkg.version.includes("-"),
      )
      .at(-1) ?? null
  );
};

const createDraft = ({
  asset,
  entry,
  head,
  notes,
  repository,
  temporaryDirectory,
}) => {
  if (entry.tagTarget === null) createTag(repository, entry.tag, head);
  const notesPath = join(
    temporaryDirectory,
    `${createHash("sha256").update(entry.tag).digest("hex")}.md`,
  );
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(notesPath, notes);
  run(
    "gh",
    buildCreateReleaseArgs({
      asset,
      notesPath,
      packageVersion: entry.pkg.version,
      repository,
      tag: entry.tag,
    }),
  );
};

const load = () => {
  const repository = process.env.GITHUB_REPOSITORY;
  const head = resolveSourceSha({
    githubSha: process.env.GITHUB_SHA,
    sourceSha: process.env.SOURCE_SHA,
  });
  if (!repository) fail("GITHUB_REPOSITORY is required.");
  const packages = readPackages(lines(process.env.PACKAGE_FILES));
  const tarballs = listTarballs(
    process.env.ARTIFACT_DIRECTORY,
    packages.length,
  );
  if (tarballs.length === 0) fail("No .tgz release artifacts were downloaded.");
  const artifactsByName = mapArtifacts(packages, tarballs.map(readArtifact));
  const releasesByTag = indexReleases(
    githubJsonPages(`repos/${repository}/releases?per_page=100`),
  );
  const remoteStates = new Map(
    packages.map((pkg) => {
      const artifact = artifactsByName.get(pkg.name);
      return [
        pkg.name,
        remoteState({
          head,
          localIntegrity: artifact.integrity,
          pkg,
          releasesByTag,
          repository,
        }),
      ];
    }),
  );
  return {
    artifactsByName,
    head,
    packages,
    repository,
    plan: createPlan({ artifactsByName, head, remoteStates }),
  };
};

const pendingStagingEntries = (state) =>
  state.plan.entries.filter(
    (entry) =>
      entry.status === "stage-and-publish" ||
      entry.status === "repair-release",
  );

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const waitForStagedState = async ({
  loadState = load,
  recheckDelays = STAGING_RECHECK_DELAYS_MILLISECONDS,
  wait = sleep,
} = {}) => {
  let state = loadState();
  for (const delay of recheckDelays) {
    const pending = pendingStagingEntries(state);
    if (pending.length === 0) return state;
    console.log(
      `::notice::Waiting ${delay}ms for GitHub to expose staged release state: ${pending.map((entry) => entry.tag).join(", ")}`,
    );
    await wait(delay);
    state = loadState();
  }
  return state;
};

export const prepare = async () => {
  validateDistTag(process.env.DIST_TAG);
  validateGithubLatestPolicy(process.env.GITHUB_LATEST_POLICY);
  const state = load();
  const temporaryDirectory = join(
    process.env.RUNNER_TEMP,
    "npm-independent-release",
  );

  const drafts = new Map();
  for (const entry of state.plan.entries) {
    console.log(
      `::notice::${entry.pkg.name}@${entry.pkg.version}: ${entry.status}; sha256=${entry.sha256}`,
    );
    if (
      entry.status === "stage-and-publish" ||
      entry.status === "repair-release"
    ) {
      drafts.set(entry.pkg.name, {
        asset:
          entry.status === "repair-release"
            ? await registryAsset({ entry, temporaryDirectory })
            : entry.path,
        notes: notesFor(entry),
      });
    }
  }

  // Complete every local and registry validation before creating any tag or draft.
  for (const entry of state.plan.entries) {
    if (
      entry.status === "stage-and-publish" ||
      entry.status === "repair-release"
    ) {
      createDraft({
        ...drafts.get(entry.pkg.name),
        entry,
        head: state.head,
        repository: state.repository,
        temporaryDirectory,
      });
    }
  }

  // GitHub's release list can lag a successful draft creation. Re-read with a
  // bounded backoff so publishing still requires every exact draft asset.
  const staged = await waitForStagedState();
  for (const entry of pendingStagingEntries(staged)) {
    fail(`Failed to stage ${entry.tag}.`);
  }
  appendOutput("tarballs", staged.plan.missingTarballs.join("\n"));
  appendOutput("changed", staged.plan.alreadyReleased ? "false" : "true");
};

export const finalize = () => {
  const latestPolicy = validateGithubLatestPolicy(
    process.env.GITHUB_LATEST_POLICY,
  );
  const packages = readPackages(lines(process.env.PACKAGE_FILES));
  for (const pkg of packages) {
    let visible = false;
    for (let attemptNumber = 1; attemptNumber <= 6; attemptNumber += 1) {
      if (npmState(pkg.name, pkg.version).exists) {
        visible = true;
        break;
      }
      if (attemptNumber < 6) run("sleep", [String(attemptNumber * 5)]);
    }
    if (!visible) fail(`npm is still missing ${pkg.name}@${pkg.version}.`);
  }

  const state = load();
  for (const entry of state.plan.entries) {
    if (!entry.registry.exists)
      fail(`npm is still missing ${entry.pkg.name}@${entry.pkg.version}.`);
    if (entry.status !== "complete" && entry.status !== "publish-draft") {
      fail(`${entry.tag} is not ready to publish; state is ${entry.status}.`);
    }
  }
  for (const entry of state.plan.entries) {
    if (entry.status === "publish-draft") {
      run(
        "gh",
        buildPublishReleaseArgs({
          repository: state.repository,
          tag: entry.tag,
        }),
      );
    }
  }

  const completed = load();
  for (const entry of completed.plan.entries) {
    if (entry.status !== "complete")
      fail(`${entry.tag} did not reach complete state.`);
  }
  const latestEntry = selectLatestReleaseEntry({
    entries: completed.plan.entries,
    head: completed.head,
    policy: latestPolicy,
  });
  if (latestEntry) {
    run(
      "gh",
      buildMarkLatestArgs({
        repository: completed.repository,
        tag: latestEntry.tag,
      }),
    );
  }
};
