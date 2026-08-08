import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const LOCAL_SPECIFIER = /^(?:workspace|catalog|link|file):/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIST_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const fail = (message) => {
  throw new Error(message);
};

export const lines = (value) =>
  (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

export const packageTag = ({ name, version }) => `${name}@${version}`;

export const validateArtifactRun = ({
  artifactRun,
  currentRun,
  sourceSha,
}) => {
  if (artifactRun.head_sha !== sourceSha) {
    fail(
      `Recovery artifact run used ${artifactRun.head_sha}, not release commit ${sourceSha}.`,
    );
  }
  if (artifactRun.path !== currentRun.path) {
    fail(
      `Recovery artifacts came from '${artifactRun.path}', not '${currentRun.path}'.`,
    );
  }
  return artifactRun;
};

/**
 * Two releases sharing a tag is genuinely ambiguous: GitHub allows any number
 * of drafts on one tag, and publishing an arbitrary one of them is not a choice
 * this action may make.
 *
 * Seeing the same release twice is not that. The releases endpoint is offset
 * paginated, and `prepare` creates drafts immediately before re-reading the
 * list, so a draft becoming visible between two page requests shifts every
 * later entry down and returns whichever release sat on the page boundary on
 * both pages. That is the same replication lag `waitForStagedState` already
 * retries through, so failing on it converts a transient read into a failed
 * release. Distinguishing the two cases by id keeps the ambiguity fatal and
 * lets the retry absorb the shift.
 *
 * The opposite shift, an entry skipped rather than repeated, needs no handling
 * here: a missing draft leaves its entry pending and the same retry re-reads.
 */
export const indexReleases = (pages) => {
  const releases = new Map();
  for (const page of pages) {
    if (!Array.isArray(page)) fail("GitHub releases response was not paginated.");
    for (const release of page) {
      if (typeof release.tag_name !== "string" || !release.tag_name) {
        fail("GitHub release is missing its tag name.");
      }
      const seen = releases.get(release.tag_name);
      if (seen && seen.id !== release.id) {
        fail(`GitHub returned duplicate releases for '${release.tag_name}'.`);
      }
      if (seen) continue;
      releases.set(release.tag_name, {
        id: release.id,
        draft: release.draft,
        prerelease: release.prerelease,
        assets: release.assets.map(({ id, name }) => ({ id, name })),
      });
    }
  }
  return releases;
};

export const validateDistTag = (distTag) => {
  if (!DIST_TAG.test(distTag) || SEMVER.test(distTag)) {
    fail(`Invalid npm dist-tag '${distTag}'.`);
  }
  return distTag;
};

export const readPackages = (packageFiles) => {
  if (packageFiles.length === 0)
    fail("package-files did not contain any paths.");

  const names = new Set();
  const packages = [];
  for (const file of packageFiles) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest)
    ) {
      fail(`${file} is not a package.json object.`);
    }
    if (manifest.private)
      fail(`${file} is private; only public manifests may be released.`);
    if (
      typeof manifest.name !== "string" ||
      !manifest.name ||
      /[\s\0]/.test(manifest.name)
    ) {
      fail(`${file} has an invalid package name.`);
    }
    if (
      typeof manifest.version !== "string" ||
      !SEMVER.test(manifest.version)
    ) {
      fail(`${file} has invalid semver version '${manifest.version}'.`);
    }
    if (names.has(manifest.name))
      fail(`Duplicate package name '${manifest.name}'.`);
    names.add(manifest.name);
    packages.push({
      file,
      name: manifest.name,
      version: manifest.version,
      changelog: join(dirname(file), "CHANGELOG.md"),
    });
  }
  return packages;
};

export const validatePackedManifest = (artifact) => {
  const { manifest, path } = artifact;
  if (/[\r\n\0]/.test(path))
    fail("Tarball paths must not contain control characters.");
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    fail(`${path} does not contain a package.json object.`);
  }
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    fail(`${path} is missing package name or version.`);
  }
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      Array.isArray(dependencies)
    ) {
      fail(`${path}: ${section} must be an object.`);
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== "string") {
        fail(`${path}: ${section}.${name} must be a string.`);
      }
      if (LOCAL_SPECIFIER.test(specifier)) {
        fail(`${path}: unresolved ${section}.${name}=${specifier}.`);
      }
    }
  }
  return artifact;
};

export const mapArtifacts = (packages, artifacts) => {
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const artifactsByName = new Map();
  for (const candidate of artifacts) {
    const artifact = validatePackedManifest(candidate);
    const pkg = packagesByName.get(artifact.manifest.name);
    if (!pkg)
      fail(
        `${artifact.path} contains unexpected package ${artifact.manifest.name}.`,
      );
    if (artifact.manifest.version !== pkg.version) {
      fail(
        `${artifact.path} contains ${artifact.manifest.name}@${artifact.manifest.version}; expected ${pkg.version}.`,
      );
    }
    if (artifactsByName.has(pkg.name)) {
      fail(`Multiple tarballs were provided for ${pkg.name}.`);
    }
    artifactsByName.set(pkg.name, { ...artifact, pkg });
  }
  for (const pkg of packages) {
    if (!artifactsByName.has(pkg.name))
      fail(`No tarball was provided for ${pkg.name}.`);
  }
  return artifactsByName;
};

export const topologicalPackageNames = (artifactsByName) => {
  const dependants = new Map();
  const incoming = new Map();
  for (const name of artifactsByName.keys()) {
    dependants.set(name, new Set());
    incoming.set(name, 0);
  }

  for (const [name, { manifest }] of artifactsByName) {
    const internalDependencies = new Set();
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependencyName of Object.keys(manifest[section] ?? {})) {
        if (artifactsByName.has(dependencyName))
          internalDependencies.add(dependencyName);
      }
    }
    incoming.set(name, internalDependencies.size);
    for (const dependencyName of internalDependencies) {
      dependants.get(dependencyName).add(name);
    }
  }

  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
    .sort();
  const ordered = [];
  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(name);
    for (const dependant of [...dependants.get(name)].sort()) {
      const count = incoming.get(dependant) - 1;
      incoming.set(dependant, count);
      if (count === 0) {
        ready.push(dependant);
        ready.sort();
      }
    }
  }
  if (ordered.length !== artifactsByName.size) {
    const cycle = [...incoming]
      .filter(([, count]) => count > 0)
      .map(([name]) => name)
      .sort()
      .join(", ");
    fail(`Release packages contain an internal dependency cycle: ${cycle}.`);
  }
  return ordered;
};

export const changelogSection = (text, version, path) => {
  const documentLines = text.split(/\r?\n/);
  const heading = `## ${version}`;
  const start = documentLines.findIndex((line) => line.trim() === heading);
  if (start === -1) fail(`${path} is missing the ${heading} section.`);
  const next = documentLines.findIndex(
    (line, index) => index > start && /^##\s+/.test(line),
  );
  const section = documentLines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  if (!section) fail(`${path} has an empty ${heading} section.`);
  return section;
};

export const hashBuffer = (algorithm, buffer) =>
  `${algorithm}-${createHash(algorithm).update(buffer).digest("base64")}`;

export const sha256File = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export const classifyState = ({
  assetIntegrity,
  expectedAssetName,
  head,
  localIntegrity,
  registry,
  release,
  tagTarget,
}) => {
  if (release && tagTarget === null)
    fail("GitHub release exists without its git tag.");
  if (release && release.assets.length !== 1) {
    fail(
      `GitHub release must contain exactly one asset; found ${release.assets.length}.`,
    );
  }
  if (release && !release.assets[0].name.endsWith(".tgz")) {
    fail(`GitHub release asset '${release.assets[0].name}' is not a tarball.`);
  }
  if (release && release.assets[0].name !== expectedAssetName) {
    fail(
      `GitHub release asset '${release.assets[0].name}' does not match '${expectedAssetName}'.`,
    );
  }

  if (!registry.exists) {
    if (tagTarget !== null && tagTarget !== head) {
      fail(
        `Unpublished version tag points at ${tagTarget}, not release commit ${head}.`,
      );
    }
    if (release && !release.draft)
      fail("Public GitHub release exists before npm publication.");
    if (release && assetIntegrity !== localIntegrity) {
      fail(
        "Draft GitHub release asset does not match the tarball queued for npm.",
      );
    }
    if (release) return "ready-to-publish";
    return "stage-and-publish";
  }

  if (!registry.integrity)
    fail("Published npm version is missing dist.integrity metadata.");
  if (release && assetIntegrity !== registry.integrity) {
    fail("GitHub release asset does not match npm dist.integrity.");
  }
  if (!release) return "repair-release";
  if (release.draft) return "publish-draft";
  return "complete";
};

export const createPlan = ({ artifactsByName, head, remoteStates }) => {
  const orderedNames = topologicalPackageNames(artifactsByName);
  const entries = orderedNames.map((name) => {
    const artifact = artifactsByName.get(name);
    const remote = remoteStates.get(name);
    if (!remote) fail(`Missing remote state for ${name}.`);
    const status = classifyState({
      ...remote,
      expectedAssetName: artifactReleaseName(artifact.path),
      head,
      localIntegrity: artifact.integrity,
    });
    return { ...artifact, ...remote, status, tag: packageTag(artifact.pkg) };
  });
  return {
    entries,
    missingTarballs: entries
      .filter(({ registry }) => !registry.exists)
      .map(({ path }) => path),
    alreadyReleased: entries.every(({ status }) => status === "complete"),
  };
};

export const releaseNotes = ({ pkg, section, status }) => {
  let provenance;
  if (status === "repair-release") {
    provenance =
      `\`${pkg.name}@${pkg.version}\` already existed on npm before this release workflow ran. ` +
      "The attached asset was recovered from the registry and matches its published integrity; " +
      "this run does not claim that a local rebuild is byte-identical to the originally uploaded tarball.";
  } else {
    provenance =
      `\`${pkg.name}@${pkg.version}\` is published through npm trusted publishing with provenance. ` +
      "The attached tarball is the artifact submitted by this release workflow.";
  }
  return `${section}\n\n---\n\n${provenance}\n`;
};

export const artifactReleaseName = (path) => basename(path);
