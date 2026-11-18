import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  compareReleaseVersions,
  readNpmVisibility,
  releaseVersionFromTag,
} from "./release-state.mjs";

export const RECONCILE_OUTCOME = Object.freeze({
  published: "published",
  pending: "pending",
  overdue: "overdue",
  blocked: "blocked",
  untagged: "untagged",
});

const FAILING_OUTCOMES = new Set([RECONCILE_OUTCOME.overdue, RECONCILE_OUTCOME.blocked]);
const HOUR_MILLISECONDS = 3_600_000;
export const DEFAULT_MAX_PENDING_HOURS = 24;

const lines = (value) =>
  (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const resolveMaxPendingHours = (value) => {
  if (value === undefined || value === "") return DEFAULT_MAX_PENDING_HOURS;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`max-pending-hours must be a positive number; got '${value}'.`);
  }
  return hours;
};

// Draft releases on the version tag scheme, oldest version first so GitHub's
// legacy latest-release ordering sees them in release order. The releases
// endpoint is paginated and can repeat an entry across pages; keep one per id.
export const selectReconcileCandidates = (releases) => {
  const byId = new Map();
  for (const release of releases) {
    if (release.draft !== true) continue;
    const version = releaseVersionFromTag(release.tag_name);
    if (version === null) continue;
    byId.set(release.id, {
      id: release.id,
      tag: release.tag_name,
      version,
      createdAt: release.created_at,
    });
  }
  return [...byId.values()].sort((a, b) => compareReleaseVersions(a.version, b.version));
};

const readPackages = ({ draft, commit, packageFiles, github }) => {
  const packages = [];
  for (const file of packageFiles) {
    const text = github.readFile(file, commit);
    if (text === null) {
      return { problem: `${file} does not exist at ${draft.tag}.` };
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (error) {
      return { problem: `${file} at ${draft.tag} is not valid JSON: ${error.message}` };
    }
    if (manifest.private) continue;
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      return { problem: `${file} at ${draft.tag} is missing a package name.` };
    }
    if (manifest.version !== draft.version) {
      return {
        problem: `${file} at ${draft.tag} has version ${manifest.version}; expected ${draft.version}.`,
      };
    }
    packages.push({ name: manifest.name, version: draft.version });
  }
  if (packages.length === 0) {
    return { problem: `No public packages are configured at ${draft.tag}.` };
  }
  return { packages };
};

// Decides one draft. The release is published only when its tag resolves to a
// commit on the default branch and npm lists every package version the tagged
// manifests declare. A draft that stays incomplete past the bound fails the run.
export const reconcileDraft = ({
  draft,
  defaultBranch,
  packageFiles,
  maxPendingHours,
  now,
  github,
  readNpm,
}) => {
  const commit = github.tagCommit(draft.tag);
  if (commit === null) {
    return { ...draft, outcome: RECONCILE_OUTCOME.untagged, detail: `${draft.tag} has no tag; it was not staged by the finalizer.` };
  }
  if (!github.isCommitOnBranch(commit, defaultBranch)) {
    return {
      ...draft,
      outcome: RECONCILE_OUTCOME.blocked,
      detail: `${draft.tag} points at ${commit}, which is not on ${defaultBranch}.`,
    };
  }
  const { packages, problem } = readPackages({ draft, commit, packageFiles, github });
  if (problem !== undefined) {
    return { ...draft, outcome: RECONCILE_OUTCOME.blocked, detail: problem };
  }

  const missing = [];
  for (const pkg of packages) {
    const state = readNpm(pkg.name, pkg.version);
    if (!state.exists) missing.push({ ...pkg, error: state.error });
  }
  if (missing.length === 0) {
    github.publishRelease(draft.id);
    return { ...draft, outcome: RECONCILE_OUTCOME.published, detail: `npm lists all ${packages.length} package versions.` };
  }

  const ageHours = (now - Date.parse(draft.createdAt)) / HOUR_MILLISECONDS;
  const specs = missing
    .map((pkg) => `${pkg.name}@${pkg.version}${pkg.error ? ` (${pkg.error})` : ""}`)
    .join(", ");
  if (ageHours > maxPendingHours) {
    return {
      ...draft,
      outcome: RECONCILE_OUTCOME.overdue,
      detail: `npm still does not list ${specs} after ${ageHours.toFixed(1)} h (bound ${maxPendingHours} h).`,
      missing,
    };
  }
  return { ...draft, outcome: RECONCILE_OUTCOME.pending, detail: `npm does not list ${specs} yet.`, missing };
};

export const reconcileReleases = ({ packageFiles, maxPendingHours, now, github, readNpm }) => {
  const defaultBranch = github.defaultBranch();
  return selectReconcileCandidates(github.listReleases()).map((draft) =>
    reconcileDraft({ draft, defaultBranch, packageFiles, maxPendingHours, now, github, readNpm }),
  );
};

export const reconcileFailed = (results) =>
  results.some((result) => FAILING_OUTCOMES.has(result.outcome));

const isNotFound = (error) => /HTTP 404/.test(String(error.stderr ?? ""));

// GitHub REST access through the gh CLI, authenticated by GH_TOKEN.
export const createGitHubClient = ({ repository, gh }) => {
  const api = (args, { allowNotFound = false } = {}) => {
    try {
      return gh(["api", ...args]);
    } catch (error) {
      if (allowNotFound && isNotFound(error)) return null;
      throw error;
    }
  };
  const json = (args, options) => {
    const text = api(args, options);
    return text === null ? null : JSON.parse(text);
  };

  return {
    defaultBranch: () => json([`repos/${repository}`]).default_branch,
    listReleases: () => json(["--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]).flat(),
    tagCommit: (tag) => {
      let object = json([`repos/${repository}/git/ref/tags/${tag}`], { allowNotFound: true })?.object;
      // Follow annotated tags (bounded) to the commit they name.
      for (let depth = 0; object?.type === "tag" && depth < 5; depth += 1) {
        object = json([`repos/${repository}/git/tags/${object.sha}`]).object;
      }
      if (object === undefined) return null;
      if (object.type !== "commit") {
        throw new Error(`${tag} resolves to a ${object.type}, not a commit.`);
      }
      return object.sha;
    },
    // The compare base is an ancestor of the branch head exactly when the
    // head is ahead of it or identical to it.
    isCommitOnBranch: (commit, branch) => {
      const { status } = json([
        `repos/${repository}/compare/${commit}...${encodeURIComponent(branch)}?per_page=1`,
      ]);
      return status === "ahead" || status === "identical";
    },
    readFile: (path, commit) =>
      api(
        [
          "-H",
          "Accept: application/vnd.github.raw+json",
          `repos/${repository}/contents/${path}?ref=${commit}`,
        ],
        { allowNotFound: true },
      ),
    // `legacy` keeps GitHub's latest marker on the highest released version,
    // so publishing an older draft never moves it backwards.
    publishRelease: (id) => {
      api([
        "--method",
        "PATCH",
        `repos/${repository}/releases/${id}`,
        "-F",
        "draft=false",
        "-f",
        "make_latest=legacy",
      ]);
    },
  };
};

const defaultGh = (args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const ANNOTATION = {
  [RECONCILE_OUTCOME.published]: "notice",
  [RECONCILE_OUTCOME.pending]: "notice",
  [RECONCILE_OUTCOME.untagged]: "notice",
  [RECONCILE_OUTCOME.overdue]: "error",
  [RECONCILE_OUTCOME.blocked]: "error",
};

export const runReconcile = ({
  env = process.env,
  now = Date.now(),
  gh = defaultGh,
  readNpm = readNpmVisibility,
  log = console.log,
} = {}) => {
  const packageFiles = lines(env.PACKAGE_FILES);
  if (packageFiles.length === 0) {
    throw new Error("package-files did not contain any package.json paths.");
  }
  const github = createGitHubClient({ repository: env.REPOSITORY, gh });
  const results = reconcileReleases({
    packageFiles,
    maxPendingHours: resolveMaxPendingHours(env.MAX_PENDING_HOURS),
    now,
    github,
    readNpm,
  });

  if (results.length === 0) log("::notice::No draft releases on the version tag scheme.");
  for (const result of results) {
    log(`::${ANNOTATION[result.outcome]}::${result.tag} ${result.outcome}: ${result.detail}`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        "| Release | Outcome | Detail |",
        "| --- | --- | --- |",
        ...results.map((result) => `| ${result.tag} | ${result.outcome} | ${result.detail.replaceAll("|", "\\|")} |`),
        "",
      ].join("\n"),
    );
  }
  return reconcileFailed(results) ? 1 : 0;
};
