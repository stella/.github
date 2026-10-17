import { YAML } from "bun";
import { readFile } from "node:fs/promises";

export const REQUIRED_BOTS = [
  "dependabot[bot]",
  "renovate[bot]",
  "github-actions[bot]",
  "stella-provenance-updater[bot]",
];
const DAY_MS = 86_400_000;
const CLA_WORKFLOW = "stella/.github/.github/workflows/cla.yml@";

type Caller = { uses?: string; if?: string; with?: { allowlist?: string } };
type ApiResult = { content?: string; commit?: { committer: { date: string } } };
type Config = { repositories: string[]; maxPinAgeDays: number };

export function inspectCaller(source: string): string {
  const workflow: {
    on?: { pull_request_target?: Record<string, unknown> | null };
    jobs?: Record<string, Caller>;
  } = YAML.parse(source);
  const trigger = workflow.on?.pull_request_target;
  if (trigger === undefined) throw new Error("missing pull_request_target trigger");
  if (trigger && ["branches", "branches-ignore", "paths", "paths-ignore"].some((key) => key in trigger)) {
    throw new Error("CLA trigger must cover every pull request");
  }
  const jobs = Object.values(workflow.jobs ?? {});
  const callers = jobs.filter((job) => job.uses?.startsWith(CLA_WORKFLOW));
  if (callers.length !== 1) throw new Error("expected one shared CLA caller");
  const caller = callers[0]!;
  const folded = String(caller.if ?? "").replace(/\s+/gu, " ").trim();
  const privateGuard = /^!github\.event\.repository\.private && \(\s*/u;
  const condition = privateGuard.test(folded)
    ? folded.replace(privateGuard, "").replace(/\s*\)$/u, "")
    : folded;
  // Require the PR arm to be unconditional; signature/recheck filtering belongs
  // only in the issue_comment arm. Never evaluate repository expressions here.
  const prArm = "(?:\\(\\s*github\\.event_name == 'pull_request_target'\\s*\\)|github\\.event_name == 'pull_request_target')";
  const commentArm = "\\(\\s*github\\.event_name == 'issue_comment'\\s*&&\\s*github\\.event\\.issue\\.pull_request\\s*&&\\s*\\(\\s*github\\.event\\.comment\\.body == 'recheck'\\s*\\|\\|\\s*github\\.event\\.comment\\.body == 'I have read the CLA Document and I hereby sign the CLA'\\s*\\)\\s*\\)";
  if (!new RegExp(`^${prArm}\\s*\\|\\|\\s*${commentArm}$`, "u").test(condition)) {
    throw new Error("CLA caller must run for every pull_request_target, including bots");
  }
  const allowlist = new Set(String(caller.with?.allowlist ?? "").split(",").map((name) => name.trim()));
  for (const bot of REQUIRED_BOTS) {
    if (!allowlist.has(bot)) throw new Error(`missing allowlisted bot: ${bot}`);
  }
  const sha = caller.uses!.slice(CLA_WORKFLOW.length);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("CLA workflow must use a full commit SHA");
  return sha;
}

export function checkPinAge(date: string, maxPinAgeDays: number, now = Date.now()): void {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxPinAgeDays * DAY_MS) {
    throw new Error(`CLA workflow pin must be at most ${maxPinAgeDays} days old`);
  }
}

export async function auditConsumers(config: Config, api: (path: string) => Promise<ApiResult>) {
  const commits = new Map<string, ApiResult>();
  const failures: string[] = [];
  for (const repository of config.repositories) {
    try {
      const file = await api(`repos/stella/${repository}/contents/.github/workflows/cla.yml`);
      if (typeof file.content !== "string") throw new Error("missing CLA workflow content");
      const sha = inspectCaller(Buffer.from(file.content, "base64").toString("utf8"));
      let commit = commits.get(sha);
      if (!commit) {
        commit = await api(`repos/stella/.github/commits/${sha}`);
        commits.set(sha, commit);
      }
      if (!commit.commit?.committer.date) throw new Error("missing CLA commit date");
      checkPinAge(commit.commit.committer.date, config.maxPinAgeDays);
      console.log(`${repository}: CLA caller OK (${sha})`);
    } catch (error) {
      failures.push(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) {
  const config = JSON.parse(await readFile(new URL("./cla-consumers.json", import.meta.url), "utf8"));
  const api = async (path: string) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
    return response.json();
  };
  await auditConsumers(config, api);
}
