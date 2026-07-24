import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const lines = (value) =>
  (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const fail = (message) => {
  throw new Error(message);
};

const required = (environment, name) => {
  const value = environment[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
};

export const allowedPackageNames = (packageFiles) => {
  const names = new Set();
  for (const file of packageFiles) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest) ||
      typeof manifest.name !== "string" ||
      manifest.name.length === 0
    ) {
      fail(`${file} is not a named package.json object.`);
    }
    if (manifest.private) fail(`${file} is private and cannot be targeted by a changeset.`);
    if (names.has(manifest.name)) fail(`Duplicate package name '${manifest.name}'.`);
    names.add(manifest.name);
  }
  return names;
};

export const validateChangeset = (file, text, packageNames) => {
  const documentLines = text.trim().split(/\r?\n/);
  const closingMarker = documentLines.indexOf("---", 1);
  if (documentLines[0] !== "---" || closingMarker === -1) {
    fail(`${file} is not a valid Changesets markdown entry.`);
  }

  const frontmatter = documentLines.slice(1, closingMarker).join("\n").trim();
  const summary = documentLines.slice(closingMarker + 1).join("\n").trim();
  if (!frontmatter) return;

  const seen = new Set();
  for (const line of lines(frontmatter)) {
    const release = line.match(/^(?:"([^"]+)"|'([^']+)'|([^:'"]+)): (patch|minor|major)$/);
    if (!release) fail(`${file} has malformed release frontmatter: '${line}'.`);
    const packageName = (release[1] ?? release[2] ?? release[3]).trim();
    if (!packageNames.has(packageName)) {
      fail(`${file} targets unknown or non-publishable package '${packageName}'.`);
    }
    if (seen.has(packageName)) fail(`${file} targets '${packageName}' more than once.`);
    seen.add(packageName);
  }
  if (!summary) fail(`${file} must include a release summary.`);
};

export const isGeneratedVersionPullRequest = ({
  changedFiles,
  environment,
  unexpectedFiles,
}) =>
  environment.HEAD_REF === environment.VERSION_BRANCH &&
  environment.HEAD_REPOSITORY === environment.REPOSITORY &&
  environment.PR_AUTHOR === environment.VERSION_PR_AUTHOR &&
  changedFiles.includes(environment.VERSION_FILE) &&
  unexpectedFiles.length === 0;

export const generatedExclusions = (generatedPaths, changesetPathspec) =>
  [...generatedPaths, changesetPathspec].map(
    (pathspec) => `:(top,exclude)${pathspec}`,
  );

const run = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const main = (environment) => {
  const baseRef = required(environment, "BASE_REF");
  const diff = (filter, pathspecs) => {
    try {
      return lines(
        run("git", [
          "diff",
          "--name-only",
          `--diff-filter=${filter}`,
          `${baseRef}...HEAD`,
          "--",
          ...pathspecs,
        ]),
      );
    } catch (error) {
      fail(`git diff failed: ${error.stderr?.toString() ?? error}`);
    }
  };

  const packageNames = allowedPackageNames(lines(required(environment, "PACKAGE_FILES")));
  const changesetPathspec = ".changeset/*.md";
  const changesetFile = (file) =>
    file.startsWith(".changeset/") &&
    file.endsWith(".md") &&
    file !== ".changeset/README.md";
  const changedFiles = diff("ACMRD", ["."]);
  const addedChangesets = diff("A", [changesetPathspec]).filter(changesetFile);
  const pendingChangesets = diff("ACMR", [changesetPathspec]).filter(changesetFile);
  for (const file of pendingChangesets) {
    validateChangeset(file, readFileSync(file, "utf8"), packageNames);
  }

  const runtimeChanged =
    diff("ACMRD", lines(required(environment, "RELEASE_PATHS"))).length > 0;
  if (!runtimeChanged) {
    console.log("No published runtime changes; changeset not required.");
    return;
  }

  const exclusions = generatedExclusions(
    lines(required(environment, "GENERATED_PATHS")),
    changesetPathspec,
  );
  const unexpectedFiles = diff("ACMRD", [".", ...exclusions]);
  if (isGeneratedVersionPullRequest({ changedFiles, environment, unexpectedFiles })) {
    console.log("Generated version PR contains synchronized release metadata. OK.");
    return;
  }

  if (addedChangesets.length > 0) {
    console.log("Published runtime change has a changeset. OK.");
    return;
  }

  fail(
    "Published runtime changes require a newly added changeset. Run `bun run changeset`, or add an empty changeset for an intentional no-release change.",
  );
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.env);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
