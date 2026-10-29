import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const NON_LINUX = /(?:macos|windows)/iu;
const JOB_START = /^  ([A-Za-z0-9_-]+):\s*$/gmu;

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
  const runner = job.match(/^    runs-on:\s*(.+)$/mu)?.[1] ?? "";
  if (NON_LINUX.test(runner)) return true;
  return /\$\{\{[^}]*matrix\./u.test(runner);
}

function runsFullBunSuite(job) {
  const commands = [...job.matchAll(/^\s+-\s+run:\s*(?:[>|]-?\s*)?(.*)$/gmu)];
  return commands.some((match) => {
    const precedingStep = job.slice(0, match.index).split(/^\s+-\s+/mu).at(-1) ?? "";
    if (/if:\s*runner\.os\s*==\s*['"]Linux['"]/u.test(precedingStep)) return false;
    const inline = match[1].trim();
    if (inline) return /^bun test(?:\s+(?:--\S+))*\s*(?:#.*)?$/u.test(inline);
    const tail = job.slice((match.index ?? 0) + match[0].length).split(/^\s+-\s/u)[0];
    return tail.split("\n").some((line) => /^\s*bun test(?:\s+(?:--\S+))*\s*(?:#.*)?$/u.test(line));
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
