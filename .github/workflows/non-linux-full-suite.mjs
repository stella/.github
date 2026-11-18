import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const NON_LINUX = /(?:macos|windows)/iu;
const JOB_START = /^  ([A-Za-z0-9_-]+):\s*$/gmu;
const STEP_START = /^ {6}- /gmu;
const FULL_SUITE = /^bun test(?:\s+--\S+)*\s*(?:#.*)?$/u;
const LINUX_ONLY = /^\s+if:\s*\$?\{?\{?\s*runner\.os\s*==\s*['"]Linux['"]\s*\}?\}?\s*$/mu;

function jobBlocks(source) {
  const jobs = source.split(/^jobs:\s*$/mu)[1];
  if (!jobs) return [];
  const starts = [...jobs.matchAll(JOB_START)];
  return starts.map((match, index) => ({
    id: match[1],
    source: jobs.slice(match.index, starts[index + 1]?.index ?? jobs.length),
  }));
}

function mayUseNonLinuxRunner(job) {
  const runner = job.match(/^ {4}runs-on:\s*(.+)$/mu)?.[1] ?? "";
  if (NON_LINUX.test(runner)) return true;
  return /\$\{\{[^}]*matrix\./u.test(runner);
}

function stepBlocks(job) {
  const starts = [...job.matchAll(STEP_START)];
  return starts.map((match, index) => job.slice(match.index, starts[index + 1]?.index ?? job.length));
}

function runCommands(step) {
  const run = step.match(/^(?: {6}- | {8})run:[ \t]*(.*)$/mu);
  if (!run) return [];
  const inline = run[1].trim();
  if (inline && !/^[>|][-+]?$/u.test(inline)) return [inline];
  const body = step.slice((run.index ?? 0) + run[0].length).split("\n");
  const lines = [];
  for (const line of body.slice(1)) {
    if (line.trim() && !/^ {10}/u.test(line)) break;
    lines.push(line.trim());
  }
  return lines.filter(Boolean);
}

function runsFullBunSuite(job) {
  return stepBlocks(job).some((step) => {
    if (LINUX_ONLY.test(step)) return false;
    return runCommands(step).some((command) => FULL_SUITE.test(command));
  });
}

export function findNonLinuxFullSuites(source) {
  return jobBlocks(source)
    .filter(({ source: job }) => mayUseNonLinuxRunner(job) && runsFullBunSuite(job))
    .map(({ id }) => id);
}

export function auditWorkflowDirectory(directory) {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  const failures = [];
  for (const file of readdirSync(path).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    for (const job of findNonLinuxFullSuites(readFileSync(join(path, file), "utf8"))) {
      failures.push(`${basename(file)}: job ${job} may run the full bun test suite on macOS or Windows`);
    }
  }
  return failures;
}
