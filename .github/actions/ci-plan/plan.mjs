import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Suite depth: `fast` runs what the changed paths select; `full` is the depth a
// merge queue, a manual run, a push and a `ci:full` pull request plan.
export const SUITE_DEPTH = { fast: "fast", full: "full" };

// What a full-depth run does to the path scopes. `scoped` keeps them (the
// caller gates its heavy suites on `suite-depth` instead); `all` selects every
// area.
export const FULL_DEPTH = { all: "all", scoped: "scoped" };

// Whether a run that selects every area also selects this one. An area that
// describes a specific change (a release version bump, say) excludes itself.
export const RUN_ALL = { exclude: "exclude", include: "include" };

const SCOPED_EVENTS = new Set(["pull_request", "merge_group"]);
const AREA_NAME = /^[a-z][a-z0-9_]*$/u;
const POLICY_KEYS = new Set(["runAll", "fullDepth", "areas"]);
const AREA_KEYS = new Set(["paths", "with", "runAll"]);

const fail = (message) => {
  throw new Error(message);
};

const required = (environment, name) => {
  const value = environment[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
};

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");

const CHARACTER_CLASS = /^(?:[A-Za-z0-9]|[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9])+$/u;

// GitHub's `paths` filter syntax: `*` matches within one path segment, `**`
// matches across segments, `?` matches one character, `[a-z]` matches an
// alphanumeric character from a set or range, and `{a,b}` matches either
// alternative.
export const globToRegExp = (glob) => {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "\\") {
      if (index + 1 === glob.length) fail(`Trailing '\\' in pattern '${glob}'.`);
      source += escapeRegExp(glob[index + 1]);
      index += 1;
      continue;
    }
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "[") {
      const close = glob.indexOf("]", index + 1);
      if (close === -1) fail(`Unclosed '[' in pattern '${glob}'.`);
      const characters = glob.slice(index + 1, close);
      if (!CHARACTER_CLASS.test(characters)) {
        fail(
          `Invalid character class '[${characters}]' in pattern '${glob}': use alphanumeric characters and ranges.`,
        );
      }
      for (const [, first, last] of characters.matchAll(/([A-Za-z0-9])-([A-Za-z0-9])/gu)) {
        if (first > last) fail(`Reversed range '${first}-${last}' in pattern '${glob}'.`);
      }
      source += `[${characters}]`;
      index = close;
      continue;
    }
    if (character === "{") {
      const close = glob.indexOf("}", index);
      if (close === -1) fail(`Unclosed '{' in pattern '${glob}'.`);
      const alternatives = glob.slice(index + 1, close).split(",");
      source += `(?:${alternatives.map((alternative) => globToRegExp(alternative).source.slice(1, -1)).join("|")})`;
      index = close;
      continue;
    }
    source += escapeRegExp(character);
  }
  return new RegExp(`^${source}$`, "u");
};

const compilePatterns = (patterns) =>
  patterns.map((pattern) =>
    pattern.startsWith("!")
      ? { include: false, regExp: globToRegExp(pattern.slice(1)) }
      : { include: true, regExp: globToRegExp(pattern) },
  );

// GitHub's `paths` ordering: the last pattern a path matches decides, so a
// `!pattern` excludes what an earlier pattern included, and a later positive
// pattern includes it again.
const selects = (compiled, file) => {
  let selected = false;
  for (const { include, regExp } of compiled) {
    if (regExp.test(file)) selected = include;
  }
  return selected;
};

export const matchesPaths = (patterns, file) => selects(compilePatterns(patterns), file);

const isPatternList = (value) =>
  Array.isArray(value) &&
  value.every((pattern) => typeof pattern === "string" && pattern.length > 0 && pattern !== "!");

export const validatePolicy = (policy) => {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    fail("The CI plan policy must be a JSON object.");
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) fail(`Unknown policy key '${key}'.`);
  }
  if (!isPatternList(policy.runAll)) fail("'runAll' must be a list of path patterns.");
  if (!Object.values(FULL_DEPTH).includes(policy.fullDepth)) {
    fail(`'fullDepth' must be one of: ${Object.values(FULL_DEPTH).join(", ")}.`);
  }
  const areas = policy.areas;
  if (typeof areas !== "object" || areas === null || Array.isArray(areas)) {
    fail("'areas' must be an object of named areas.");
  }
  const names = Object.keys(areas);
  if (names.length === 0) fail("'areas' must name at least one area.");
  for (const name of names) {
    if (!AREA_NAME.test(name)) fail(`Area name '${name}' must match ${AREA_NAME}.`);
    const area = areas[name];
    if (typeof area !== "object" || area === null || Array.isArray(area)) {
      fail(`Area '${name}' must be an object.`);
    }
    for (const key of Object.keys(area)) {
      if (!AREA_KEYS.has(key)) fail(`Area '${name}' has unknown key '${key}'.`);
    }
    if (!isPatternList(area.paths)) fail(`Area '${name}' needs 'paths', a list of path patterns.`);
    if (!area.paths.some((pattern) => !pattern.startsWith("!"))) {
      fail(`Area '${name}' 'paths' must contain at least one positive pattern.`);
    }
    if (area.with !== undefined) {
      if (!Array.isArray(area.with)) fail(`Area '${name}' 'with' must be a list of area names.`);
      for (const other of area.with) {
        if (!Object.hasOwn(areas, other)) fail(`Area '${name}' 'with' names unknown area '${other}'.`);
        if (other === name) fail(`Area '${name}' cannot list itself in 'with'.`);
      }
    }
    if (area.runAll !== undefined && !Object.values(RUN_ALL).includes(area.runAll)) {
      fail(`Area '${name}' 'runAll' must be one of: ${Object.values(RUN_ALL).join(", ")}.`);
    }
    // Compiling rejects malformed patterns before any run depends on them.
    compilePatterns(area.paths);
  }
  compilePatterns(policy.runAll);
  return policy;
};

export const resolveSuiteDepth = ({ eventName, labels, fullLabel }) => {
  if (eventName !== "pull_request") return SUITE_DEPTH.full;
  return labels.includes(fullLabel) ? SUITE_DEPTH.full : SUITE_DEPTH.fast;
};

const QUEUED_PULL_REQUEST = /\/pr-([0-9]+)-[0-9a-f]+$/u;

// A pull_request run is trusted once it starts: same-repository authors can
// push branches, and a fork run starts only after the repository's approval
// policy lets it. A merge group runs with the base repository's secrets, so it
// is trusted when the queued pull request is from this repository, or when its
// head already passed a pull_request run of the same workflow: GitHub enqueues
// only after the required checks passed on that head and only for a user with
// write access, and a later push drops the entry.
export const resolveTrust = async ({ eventName, mergeGroupHeadRef, repository, workflowFile, api }) => {
  if (eventName !== "merge_group") return { trusted: true };
  const match = QUEUED_PULL_REQUEST.exec(mergeGroupHeadRef ?? "");
  if (!match) {
    return {
      trusted: false,
      reason: `Merge group head ref does not name a pull request: ${mergeGroupHeadRef}`,
    };
  }
  const number = match[1];
  const pull = await api(`repos/${repository}/pulls/${number}`);
  const headRepository = pull?.head?.repo?.full_name;
  const headSha = pull?.head?.sha;
  if (headRepository === repository) return { trusted: true };
  const runs = await api(
    `repos/${repository}/actions/workflows/${workflowFile}/runs?event=pull_request&status=success&head_sha=${headSha}`,
  );
  if ((runs?.total_count ?? 0) > 0) return { trusted: true };
  return {
    trusted: false,
    reason: `Merge group for fork pull request #${number} (head ${headRepository}@${headSha}) with no successful pull_request run on that head. Let CI pass on the pull request, then enqueue it again.`,
  };
};

const everyArea = (policy, selected) =>
  Object.fromEntries(
    Object.entries(policy.areas).map(([name, area]) => [
      name,
      selected && (area.runAll ?? RUN_ALL.include) === RUN_ALL.include,
    ]),
  );

// Close each area over its `with` list: an area is also selected when an area
// it lists is.
const closeOverWith = (policy, selected) => {
  const result = { ...selected };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, area] of Object.entries(policy.areas)) {
      if (result[name]) continue;
      if ((area.with ?? []).some((other) => result[other])) {
        result[name] = true;
        changed = true;
      }
    }
  }
  return result;
};

export const planScopes = ({ policy, eventName, suiteDepth, files }) => {
  if (!SCOPED_EVENTS.has(eventName)) return { runAll: true, areas: everyArea(policy, true) };
  if (suiteDepth === SUITE_DEPTH.full && policy.fullDepth === FULL_DEPTH.all) {
    return { runAll: true, areas: everyArea(policy, true) };
  }
  const runAllPatterns = compilePatterns(policy.runAll);
  if (files.some((file) => selects(runAllPatterns, file))) {
    return { runAll: true, areas: everyArea(policy, true) };
  }
  const selected = Object.fromEntries(
    Object.entries(policy.areas).map(([name, area]) => {
      const compiled = compilePatterns(area.paths);
      return [name, files.some((file) => selects(compiled, file))];
    }),
  );
  return { runAll: false, areas: closeOverWith(policy, selected) };
};

export const baseBranch = ({ baseRef, mergeGroupBaseRef, defaultBranch }) => {
  if (baseRef) return baseRef;
  if (mergeGroupBaseRef) return mergeGroupBaseRef.replace(/^refs\/heads\//u, "");
  return defaultBranch;
};

// Both sides of a rename: a file moved out of an area changes that area too.
export const changedFiles = (base) =>
  execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `origin/${base}...HEAD`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\0")
    .filter(Boolean);

const githubApi = (environment) => async (path) => {
  const url = new URL(path, `${environment.GITHUB_API_URL ?? "https://api.github.com"}/`);
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required(environment, "GITHUB_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) fail(`GET ${url.pathname} failed: ${response.status} ${await response.text()}`);
  return response.json();
};

const pullRequestLabels = async ({ api, repository, number }) => {
  const labels = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`repos/${repository}/issues/${number}/labels?per_page=100&page=${page}`);
    labels.push(...batch.map((label) => label.name));
    if (batch.length < 100) return labels;
  }
};

// `owner/repo/.github/workflows/ci.yml@refs/heads/main` → `ci.yml`.
export const workflowFileOf = (workflowRef) => {
  const match = /\/\.github\/workflows\/([^@/]+)@/u.exec(workflowRef ?? "");
  if (!match) fail(`Cannot read the workflow file from GITHUB_WORKFLOW_REF '${workflowRef}'.`);
  return match[1];
};

const writeOutputs = (environment, outputs) => {
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  appendFileSync(required(environment, "GITHUB_OUTPUT"), text);
};

// Stage one runs before checkout, so a merge group that fails the trust check
// never has its tree fetched.
export const context = async (environment, api = githubApi(environment)) => {
  const eventName = required(environment, "EVENT_NAME");
  const repository = required(environment, "REPOSITORY");
  const labels =
    eventName === "pull_request"
      ? await pullRequestLabels({ api, repository, number: required(environment, "PR_NUMBER") })
      : [];
  const suiteDepth = resolveSuiteDepth({
    eventName,
    labels,
    fullLabel: required(environment, "FULL_LABEL"),
  });
  const trust = await resolveTrust({
    eventName,
    mergeGroupHeadRef: environment.MERGE_GROUP_HEAD_REF,
    repository,
    workflowFile: eventName === "merge_group" ? workflowFileOf(environment.WORKFLOW_REF) : "",
    api,
  });
  if (!trust.trusted) fail(trust.reason);
  console.log(`Suite depth: ${suiteDepth}. Trusted: ${trust.trusted}.`);
  return { "suite-depth": suiteDepth, trusted: String(trust.trusted) };
};

export const scope = (environment, listChangedFiles = changedFiles) => {
  // An untrusted merge group was never checked out: it selects nothing, and the
  // context stage has already failed with the reason.
  if (required(environment, "TRUSTED") !== "true") return { "run-all": "false", areas: "{}" };
  const policyFile = required(environment, "POLICY_FILE");
  const policy = validatePolicy(JSON.parse(readFileSync(policyFile, "utf8")));
  const eventName = required(environment, "EVENT_NAME");
  const files = SCOPED_EVENTS.has(eventName)
    ? listChangedFiles(
        baseBranch({
          baseRef: environment.BASE_REF,
          mergeGroupBaseRef: environment.MERGE_GROUP_BASE_REF,
          defaultBranch: required(environment, "DEFAULT_BRANCH"),
        }),
      )
    : [];
  const plan = planScopes({
    policy,
    eventName,
    suiteDepth: required(environment, "SUITE_DEPTH"),
    files,
  });
  if (SCOPED_EVENTS.has(eventName)) {
    console.log(`Changed files (${files.length}):`);
    for (const file of files) console.log(` - ${file}`);
  }
  console.log(`Run all: ${plan.runAll}.`);
  for (const [name, selected] of Object.entries(plan.areas)) console.log(`${name}: ${selected}`);
  if (environment.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(plan.areas).map(([name, selected]) => `| ${name} | ${selected} |`);
    appendFileSync(
      environment.GITHUB_STEP_SUMMARY,
      `### CI plan\n\nRun all: ${plan.runAll}\n\n| Area | Selected |\n| --- | --- |\n${rows.join("\n")}\n`,
    );
  }
  return { "run-all": String(plan.runAll), areas: JSON.stringify(plan.areas) };
};

const STAGES = { context, scope };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stage = STAGES[process.argv[2]];
    if (!stage) fail(`usage: plan.mjs <${Object.keys(STAGES).join("|")}>`);
    writeOutputs(process.env, await stage(process.env));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
