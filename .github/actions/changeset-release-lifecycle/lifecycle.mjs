import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const READ_RETRY_DELAYS_MS = [1000, 3000];
const QUEUE_REJECTION =
  "A pull request for this branch has been added to a merge queue. Branches that are queued for merging cannot be updated. To modify this branch, dequeue the associated pull request.";

const query = `query($owner:String!, $name:String!, $base:String!, $number:Int!, $hasPullRequest:Boolean!) {
  repository(owner:$owner, name:$name) {
    ref(qualifiedName:$base) { target { oid } }
    pullRequest(number:$number) @include(if:$hasPullRequest) {
      number state baseRefName headRefName headRefOid isCrossRepository
      autoMergeRequest { enabledAt }
      mergeQueueEntry { id }
      timelineItems(last:1, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_DISABLED_EVENT]) {
        nodes { __typename }
      }
    }
  }
}`;

const classifyRelease = ({ sourceSha, base, repository }) => {
  if (
    !repository?.ref?.target?.oid ||
    !Object.hasOwn(repository, "pullRequest")
  ) {
    throw new Error("GitHub returned incomplete release state");
  }
  if (repository.ref.target.oid !== sourceSha) return { status: "stale" };
  const pr = repository.pullRequest;
  if (pr === null) return { status: "mutable", pullRequest: null };
  if (
    !pr ||
    !Number.isSafeInteger(pr.number) ||
    pr.number <= 0 ||
    !/^[0-9a-f]{40}$/.test(pr.headRefOid) ||
    typeof pr.isCrossRepository !== "boolean" ||
    !["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
    typeof pr.baseRefName !== "string" ||
    typeof pr.headRefName !== "string" ||
    !Object.hasOwn(pr, "autoMergeRequest") ||
    !Object.hasOwn(pr, "mergeQueueEntry") ||
    !Array.isArray(pr.timelineItems?.nodes)
  ) {
    throw new Error("GitHub returned incomplete release PR state");
  }
  if (
    pr.state !== "OPEN" ||
    pr.baseRefName !== base ||
    pr.headRefName !== `changeset-release/${base}` ||
    pr.isCrossRepository
  ) {
    return { status: "stale" };
  }
  if (pr.autoMergeRequest !== null || pr.mergeQueueEntry !== null) {
    return { status: "frozen", pullRequest: pr };
  }
  // An explicit dequeue/disable must survive scheduled reconciliation. A
  // maintainer can re-arm this PR or close it to start a replacement batch.
  if (pr.timelineItems.nodes.length > 0)
    return { status: "blocked", pullRequest: pr };
  return { status: "mutable", pullRequest: pr };
};

export const isQueueRejection = (result) => {
  if (
    result.error ||
    result.signal ||
    !Number.isInteger(result.status) ||
    result.status <= 0
  )
    return false;
  // Bun emits successful script command echoes on stderr. Anything else
  // there must be an error annotation we can classify, or remains a failure.
  if (
    (result.stderr ?? "")
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim() !== "" &&
          !line.startsWith("$ ") &&
          !/^::error(?: |::)/.test(line),
      )
  )
    return false;
  const errors = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .filter((line) => /^::error(?: |::)/.test(line));
  return (
    errors.length > 0 &&
    errors.every((line) => {
      const message = line
        .slice(line.indexOf("::", 2) + 2)
        .replace(/%0[AD]/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^HttpError: /, "");
      return (
        message ===
        `${QUEUE_REJECTION} - https://docs.github.com/articles/about-protected-branches`
      );
    })
  );
};

const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

export const createRuntime = ({
  env = process.env,
  execute = run,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  report = console.log,
  setOutput = output,
} = {}) => {
  const repository = env.GITHUB_REPOSITORY;
  const base = env.GITHUB_REF_NAME;
  const sourceSha = env.GITHUB_SHA;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !base ||
    !/^[0-9a-f]{40}$/.test(sourceSha ?? "")
  ) {
    throw new Error("A repository, base branch, and source SHA are required");
  }
  const [owner, name] = repository.split("/");
  const head = `changeset-release/${base}`;

  const gh = async (args, { read = false, allowMissing = false } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const result = execute("gh", ["api", ...args], { env });
      if (result.status === 0)
        return result.stdout.trim() ? JSON.parse(result.stdout) : null;
      if (allowMissing && /HTTP 404/.test(result.stderr)) return null;
      if (
        read &&
        attempt < READ_RETRY_DELAYS_MS.length &&
        /HTTP (429|5\d\d)/.test(result.stderr)
      ) {
        await sleep(READ_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error(
        `GitHub request failed: ${result.error?.message ?? result.stderr}`,
      );
    }
  };

  const inspect = async () => {
    // REST's owner-qualified head filter excludes fork PRs before the bound
    // is applied. GraphQL headRefName alone also matches unrelated forks.
    const pulls = await gh(
      [
        "--method",
        "GET",
        `repos/${repository}/pulls`,
        "-f",
        `head=${owner}:${head}`,
        "-f",
        `base=${base}`,
        "-f",
        "state=open",
        "-f",
        "per_page=2",
      ],
      { read: true },
    );
    if (
      !Array.isArray(pulls) ||
      pulls.some((pr) => !Number.isSafeInteger(pr?.number) || pr.number <= 0)
    ) {
      throw new Error("GitHub returned incomplete release PR lookup");
    }
    if (pulls.length > 1)
      throw new Error("Multiple open release PRs share the release branch");
    const pullNumber = pulls[0]?.number;
    const response = await gh(
      [
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `base=refs/heads/${base}`,
        "-F",
        `number=${pullNumber ?? 0}`,
        "-F",
        `hasPullRequest=${pullNumber !== undefined}`,
      ],
      { read: true },
    );
    if (response.errors?.length)
      throw new Error("GitHub could not resolve release state");
    return classifyRelease({
      sourceSha,
      base,
      repository:
        pullNumber === undefined
          ? { ...response.data?.repository, pullRequest: null }
          : response.data?.repository,
    });
  };

  const mayMutate = (state) => {
    setOutput("status", state.status);
    switch (state.status) {
      case "mutable":
        return true;
      case "stale":
        report(
          "::notice::Deferring release maintenance because the source or PR snapshot changed.",
        );
        return false;
      case "frozen":
        report(
          `::notice::Release PR #${state.pullRequest.number} is armed or queued; preserving this batch.`,
        );
        return false;
      case "blocked":
        throw new Error(
          `Release PR #${state.pullRequest.number} was dequeued or auto-merge was disabled. Resolve the failure and re-arm it, or close it to replace the batch.`,
        );
      default:
        throw new Error(`Unknown release state: ${state.status}`);
    }
  };

  return {
    inspect: async () => mayMutate(await inspect()),
    version: async () => {
      if (!mayMutate(await inspect())) return;
      if (!env.CHANGESETS_ENTRYPOINT)
        throw new Error("CHANGESETS_ENTRYPOINT is required");
      const result = execute(process.execPath, [env.CHANGESETS_ENTRYPOINT], {
        env,
      });
      if (isQueueRejection(result)) {
        setOutput("status", "frozen");
        report(
          "::notice::Release PR entered the merge queue during versioning; deferring this update.",
        );
        return;
      }
      report(result.stdout ?? "");
      report(result.stderr ?? "");
      if (result.error || result.status !== 0)
        throw new Error(
          `Changesets failed (${result.status ?? result.error?.message})`,
        );
    },
    cleanup: async () => {
      const state = await inspect();
      if (!mayMutate(state)) return;
      if (state.pullRequest) {
        await gh([
          "--method",
          "PATCH",
          `repos/${repository}/pulls/${state.pullRequest.number}`,
          "-f",
          "state=closed",
        ]);
        report(
          `::notice::Closed stale release PR #${state.pullRequest.number}.`,
        );
      }
      const ref = await gh([`repos/${repository}/git/ref/heads/${head}`], {
        read: true,
        allowMissing: true,
      });
      if (!ref) return;
      // Re-read after closing the PR: a later run or an external actor may
      // have created/armed its replacement before branch deletion.
      const latest = await inspect();
      if (!mayMutate(latest) || latest.pullRequest) return;
      await gh([
        "--method",
        "DELETE",
        `repos/${repository}/git/refs/heads/${head}`,
      ]);
      report(`::notice::Deleted stale branch ${head}.`);
    },
    merge: async () => {
      const state = await inspect();
      if (!mayMutate(state) || !state.pullRequest) return;
      if (!env.RELEASE_MERGE_COMMAND)
        throw new Error("RELEASE_MERGE_COMMAND is required");
      const result = execute(
        "bash",
        ["-euo", "pipefail", "-c", env.RELEASE_MERGE_COMMAND],
        {
          env: { ...env, RELEASE_PR_NUMBER: String(state.pullRequest.number) },
        },
      );
      report(result.stdout ?? "");
      report(result.stderr ?? "");
      if (result.error || result.status !== 0) {
        const latest = await inspect();
        if (
          latest.status === "frozen" &&
          latest.pullRequest.number === state.pullRequest.number &&
          latest.pullRequest.headRefOid === state.pullRequest.headRefOid
        ) {
          report(
            "::notice::The same release head was armed or queued during handoff; nothing more to do.",
          );
          return;
        }
        throw new Error(
          "The release merge gate refused the handoff; inspect its verdict above.",
        );
      }
    },
  };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const runtime = createRuntime();
    const command = process.argv[2];
    if (!Object.hasOwn(runtime, command))
      throw new Error("Expected inspect, version, cleanup, or merge");
    await runtime[command]();
  } catch (error) {
    console.error(
      `::error::${String(error.message).replaceAll("\n", "%0A").replaceAll("\r", "%0D")}`,
    );
    process.exitCode = 1;
  }
}
