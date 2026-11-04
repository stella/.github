import { spawnSync } from "node:child_process";

// The version tag scheme shared by npm-version-finalize.yml (which creates the
// tag and stages the draft) and npm-release-reconcile.yml (which publishes the
// draft later). Both import it so the two cannot disagree on which tags exist.
export const RELEASE_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/;
const RELEASE_TAG_PREFIX = "v";
const PRERELEASE_ORDER = ["alpha", "beta", "rc"];

export const releaseTagFor = (version) => `${RELEASE_TAG_PREFIX}${version}`;

export const releaseVersionFromTag = (tag) => {
  if (typeof tag !== "string" || !tag.startsWith(RELEASE_TAG_PREFIX)) return null;
  const version = tag.slice(RELEASE_TAG_PREFIX.length);
  return RELEASE_VERSION_PATTERN.test(version) ? version : null;
};

const versionKey = (version) => {
  const [core, prerelease] = version.split("-");
  const [major, minor, patch] = core.split(".").map(Number);
  if (prerelease === undefined) {
    return [major, minor, patch, PRERELEASE_ORDER.length, 0];
  }
  const [kind, number] = prerelease.split(".");
  return [major, minor, patch, PRERELEASE_ORDER.indexOf(kind), Number(number)];
};

export const compareReleaseVersions = (left, right) => {
  const a = versionKey(left);
  const b = versionKey(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const defaultAttempt = (command, args) =>
  spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

// A version is visible once the package document that installers resolve
// (the abbreviated packument) lists it. The request asks every cache on the
// path to revalidate, so a stale copy cannot hide a version that npm already
// serves; nothing here touches the npm CLI cache. Any failure to read the
// document reports the version as not visible, which only delays publication.
export const readNpmVisibility = (name, version, attempt = defaultAttempt) => {
  const result = attempt("curl", [
    "-sS",
    "--max-time",
    "30",
    "-H",
    "Accept: application/vnd.npm.install-v1+json",
    "-H",
    "Cache-Control: no-cache",
    "-w",
    "\n%{http_code}",
    `https://registry.npmjs.org/${name.replace("/", "%2F")}`,
  ]);
  if (result.status !== 0) {
    return { exists: false, error: `curl exited with ${result.status}: ${(result.stderr ?? "").trim()}` };
  }
  const split = result.stdout.lastIndexOf("\n");
  const status = result.stdout.slice(split + 1);
  if (status === "404") return { exists: false };
  if (status !== "200") {
    return { exists: false, error: `registry answered HTTP ${status}` };
  }
  try {
    const document = JSON.parse(result.stdout.slice(0, split));
    return { exists: Object.hasOwn(document.versions ?? {}, version) };
  } catch (error) {
    return { exists: false, error: `registry returned unreadable JSON: ${error.message}` };
  }
};

export const NPM_RELEASE_STATE = Object.freeze({
  visible: "visible",
  pending: "pending",
});

const COMPLETED_PUBLISH_OUTCOMES = new Set(["success", "skipped"]);

// Decides what the finalizer does once its visibility wait ends. A publish
// step that did not complete is a release failure; a publish that npm accepted
// but has not exposed yet is not, because npm can take close to an hour to
// list an accepted version. The GitHub release is published only when npm
// lists every version; otherwise it stays a draft for the reconcile workflow.
export const decideNpmReleaseState = ({ publishOutcome, missing }) => {
  if (!COMPLETED_PUBLISH_OUTCOMES.has(publishOutcome)) {
    throw new Error(
      `npm publish concluded '${publishOutcome}'; the release cannot be finalized.`,
    );
  }
  if (missing.length === 0) return { state: NPM_RELEASE_STATE.visible };
  return { state: NPM_RELEASE_STATE.pending, pending: missing };
};
