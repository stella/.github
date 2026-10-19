const PULL_REQUEST_EVENT = "pull_request";
const PASSING_RESULT = "success";

function asSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set(String(value ?? "").split(/[\n,]/u).map((item) => item.trim()).filter(Boolean));
}

export function decide({ event, needs, allowSkipped = [], pullRequestOnly = [], requireTrusted = "" }) {
  const lines = [];
  const jobs = needs && typeof needs === "object" && !Array.isArray(needs) ? Object.entries(needs) : [];
  const knownJobs = new Set(jobs.map(([id]) => id));
  const alwaysSkippable = asSet(allowSkipped);
  const prOnly = asSet(pullRequestOnly);
  let ok = jobs.length > 0;

  if (jobs.length === 0) lines.push("needs: empty (fail)");

  for (const [id, job] of jobs) {
    const result = job?.result;
    let rule = "must succeed";
    let passes = result === PASSING_RESULT;

    if (result === "skipped" && alwaysSkippable.has(id)) {
      rule = "skipped allowed";
      passes = true;
    } else if (prOnly.has(id)) {
      rule = event === PULL_REQUEST_EVENT ? "pull request: must succeed" : "non-pull-request: skipped allowed";
      passes = result === PASSING_RESULT || (event !== PULL_REQUEST_EVENT && result === "skipped");
    }

    lines.push(`${id}: ${String(result)} (${rule}; ${passes ? "pass" : "fail"})`);
    ok &&= passes;
  }

  for (const [listName, ids] of [["allow-skipped", alwaysSkippable], ["pull-request-only", prOnly]]) {
    for (const id of ids) {
      if (knownJobs.has(id)) continue;
      lines.push(`${id}: unknown job in ${listName} (fail)`);
      ok = false;
    }
  }

  if (event === PULL_REQUEST_EVENT && requireTrusted) {
    const separator = requireTrusted.lastIndexOf(".");
    const jobId = requireTrusted.slice(0, separator);
    const outputName = requireTrusted.slice(separator + 1);
    const value = separator > 0 ? needs?.[jobId]?.outputs?.[outputName] : undefined;
    const passes = value === "true" || value === true;
    lines.push(`${requireTrusted}: trusted output is ${String(value)} (${passes ? "pass" : "fail"})`);
    ok &&= passes;
  }

  return { ok, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let needs;
  try {
    needs = JSON.parse(process.env.INPUT_NEEDS ?? "");
  } catch (error) {
    console.error(`needs: invalid JSON (${error.message})`);
    process.exitCode = 1;
  }

  if (needs !== undefined) {
    const result = decide({
      event: process.env.GITHUB_EVENT_NAME,
      needs,
      allowSkipped: process.env.INPUT_ALLOW_SKIPPED,
      pullRequestOnly: process.env.INPUT_PULL_REQUEST_ONLY,
      requireTrusted: process.env.INPUT_REQUIRE_TRUSTED_OUTPUT,
    });
    for (const line of result.lines) console.log(line);
    if (!result.ok) process.exitCode = 1;
  }
}
