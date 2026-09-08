import assert from "node:assert/strict";
import { test } from "node:test";

import { createRuntime, isQueueRejection } from "./lifecycle.mjs";

const SOURCE_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const QUEUE_REJECTION =
  "A pull request for this branch has been added to a merge queue. " +
  "Branches that are queued for merging cannot be updated. To modify this " +
  "branch, dequeue the associated pull request.";
const QUEUE_REJECTION_LINE = `::error::${QUEUE_REJECTION} - https://docs.github.com/articles/about-protected-branches`;

const environment = {
  GITHUB_REPOSITORY: "stella/stella",
  GITHUB_REF_NAME: "main",
  GITHUB_SHA: SOURCE_SHA,
  CHANGESETS_ENTRYPOINT: "/runner/changesets-entrypoint.mjs",
  RELEASE_MERGE_COMMAND: 'bun scripts/merge-bar.ts "$RELEASE_PR_NUMBER"',
};

const releasePullRequest = (overrides = {}) => ({
  number: 42,
  headRefOid: HEAD_SHA,
  isCrossRepository: false,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  timelineItems: { nodes: [] },
  ...overrides,
});

const repository = ({
  baseSha = SOURCE_SHA,
  pullRequest = releasePullRequest(),
  pullRequests = pullRequest === null ? [] : [pullRequest],
} = {}) => ({
  ref: { target: { oid: baseSha } },
  pullRequests: { nodes: pullRequests },
});

const responseFor = (state) => JSON.stringify({ data: { repository: state } });

const makeHarness = ({
  states = [repository()],
  extraGhResponses = [],
  commandResults = [],
  env = environment,
} = {}) => {
  const calls = [];
  const sleeps = [];
  const reports = [];
  const outputs = [];
  const queuedStates = [...states];
  const queuedGhResponses = [...extraGhResponses];
  const queuedCommandResults = [...commandResults];

  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "gh") {
      const response = queuedGhResponses.shift();
      if (response !== undefined) return response;
      if (args[1] === "graphql") {
        const state =
          queuedStates.length > 1 ? queuedStates.shift() : queuedStates[0];
        return { status: 0, stdout: responseFor(state), stderr: "" };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    }
    return (
      queuedCommandResults.shift() ?? { status: 0, stdout: "", stderr: "" }
    );
  };

  const runtime = createRuntime({
    env,
    execute,
    sleep: async (delay) => sleeps.push(delay),
    report: (message) => reports.push(message),
    setOutput: (name, value) => outputs.push({ name, value }),
  });

  return { calls, outputs, reports, runtime, sleeps };
};

const mutationCalls = (calls) =>
  calls.filter(
    ({ command, args }) =>
      (command === "gh" &&
        args[1] === "--method" &&
        (args[3]?.startsWith("repos/") ?? false)) ||
      command === "bash" ||
      command === process.execPath,
  );

test("frozen, blocked, and stale states prevent every lifecycle mutation", async () => {
  const states = {
    frozen: repository({
      pullRequest: releasePullRequest({
        autoMergeRequest: { enabledAt: "2026-09-08T10:00:00Z" },
      }),
    }),
    queued: repository({
      pullRequest: releasePullRequest({ mergeQueueEntry: { id: "queue-1" } }),
    }),
    blocked: repository({
      pullRequest: releasePullRequest({
        timelineItems: {
          nodes: [{ __typename: "REMOVED_FROM_MERGE_QUEUE_EVENT" }],
        },
      }),
    }),
    stale: repository({ baseSha: OTHER_SHA }),
  };

  for (const [name, state] of Object.entries(states)) {
    const harness = makeHarness({ states: [state] });
    const expected =
      name === "blocked" ? /was dequeued or auto-merge was disabled/ : null;

    for (const operation of ["version", "cleanup", "merge"]) {
      if (expected) {
        await assert.rejects(harness.runtime[operation](), expected);
      } else {
        await harness.runtime[operation]();
      }
    }

    assert.deepEqual(
      mutationCalls(harness.calls),
      [],
      `${name} state must not invoke version, cleanup, or merge mutations`,
    );
  }
});

test("inspection is repeatable and never mutates the release branch", async () => {
  const harness = makeHarness({ states: [repository()] });

  assert.equal(await harness.runtime.inspect(), true);
  assert.equal(await harness.runtime.inspect(), true);

  assert.equal(
    harness.calls.filter(({ command }) => command === "gh").length,
    2,
  );
  assert.deepEqual(harness.sleeps, []);
  assert.deepEqual(harness.outputs, [
    { name: "status", value: "mutable" },
    { name: "status", value: "mutable" },
  ]);
});

test("incomplete GitHub state fails closed before any mutation", async () => {
  const missingPullRequestFields = [
    "number",
    "headRefOid",
    "isCrossRepository",
    "autoMergeRequest",
    "mergeQueueEntry",
    "timelineItems",
  ].map((field) => {
    const pullRequest = releasePullRequest();
    delete pullRequest[field];
    return repository({ pullRequest });
  });
  const incompleteStates = [
    {},
    { ref: { target: {} }, pullRequests: { nodes: [] } },
    { ref: { target: { oid: SOURCE_SHA } }, pullRequests: {} },
    {
      ref: { target: { oid: SOURCE_SHA } },
      pullRequests: { nodes: [{ number: 42, headRefOid: HEAD_SHA }] },
    },
    ...missingPullRequestFields,
  ];

  for (const state of incompleteStates) {
    const harness = makeHarness({ states: [state] });
    await assert.rejects(
      harness.runtime.inspect(),
      /GitHub returned incomplete release state|GitHub returned incomplete release PR state/,
    );
    assert.deepEqual(mutationCalls(harness.calls), []);
  }
});

test("a null release PR node fails closed with a lifecycle error", async () => {
  const harness = makeHarness({
    states: [
      {
        ref: { target: { oid: SOURCE_SHA } },
        pullRequests: { nodes: [null] },
      },
    ],
  });

  await assert.rejects(
    harness.runtime.inspect(),
    /GitHub returned incomplete release PR state/,
  );
  assert.deepEqual(mutationCalls(harness.calls), []);
});

test("the mutation detector observes a production-shaped cleanup write", async () => {
  const harness = makeHarness();

  await harness.runtime.cleanup();

  assert.equal(
    mutationCalls(harness.calls).some(
      ({ command, args }) =>
        command === "gh" &&
        args[2] === "PATCH" &&
        args[3] === "repos/stella/stella/pulls/42",
    ),
    true,
  );
});

test("cleanup skips branch deletion when its post-close re-read is frozen", async () => {
  const harness = makeHarness({
    states: [
      repository(),
      repository({
        pullRequest: releasePullRequest({
          mergeQueueEntry: { id: "queue-1" },
        }),
      }),
    ],
  });

  await harness.runtime.cleanup();

  const writes = mutationCalls(harness.calls).filter(
    ({ command }) => command === "gh",
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[2], "PATCH");
  assert.equal(
    writes.some(({ args }) => args[2] === "DELETE"),
    false,
  );
});

test("only the exact queue race is deferrable", () => {
  assert.equal(
    isQueueRejection({ status: 1, stdout: "", stderr: QUEUE_REJECTION_LINE }),
    true,
  );
  assert.equal(
    isQueueRejection({
      status: 1,
      stdout: "",
      stderr: `${QUEUE_REJECTION_LINE}\n::error::permission denied`,
    }),
    false,
  );
  assert.equal(
    isQueueRejection({
      status: 1,
      stdout: "",
      stderr: `${QUEUE_REJECTION_LINE}\nunannotated failure`,
    }),
    false,
  );
  assert.equal(
    isQueueRejection({
      status: 1,
      stdout: "",
      stderr: `::error::${QUEUE_REJECTION} - https://example.test`,
    }),
    false,
  );
  assert.equal(
    isQueueRejection({
      status: null,
      stdout: "",
      stderr: QUEUE_REJECTION_LINE,
    }),
    false,
  );
  assert.equal(
    isQueueRejection({
      status: 1,
      stdout: "",
      stderr: `::error::HttpError: ${QUEUE_REJECTION} - https://docs.github.com/articles/about-protected-branches%0A%0D`,
    }),
    true,
  );
});

test("a queue race during versioning is handled once without retrying the command", async () => {
  const harness = makeHarness({
    commandResults: [{ status: 1, stdout: "", stderr: QUEUE_REJECTION_LINE }],
  });

  await harness.runtime.version();

  assert.equal(
    harness.calls.filter(({ command }) => command === process.execPath).length,
    1,
  );
  assert.deepEqual(harness.sleeps, []);
  assert.equal(harness.outputs.at(-1)?.value, "frozen");
});

test("successful Bun command echoes do not turn a queue deferral into failure", () => {
  assert.equal(
    isQueueRejection({
      status: 1,
      stdout: QUEUE_REJECTION_LINE,
      stderr: "$ bun scripts/version.ts\n",
    }),
    true,
  );
});

test("handoff races converge only when the same release head was armed", async () => {
  for (const headRefOid of [HEAD_SHA, OTHER_SHA]) {
    const harness = makeHarness({
      states: [
        repository(),
        repository({
          pullRequest: releasePullRequest({
            headRefOid,
            mergeQueueEntry: { id: "queued" },
          }),
        }),
      ],
      commandResults: [{ status: 1, stdout: "", stderr: "concurrent handoff" }],
    });
    if (headRefOid === HEAD_SHA) await harness.runtime.merge();
    else
      await assert.rejects(
        harness.runtime.merge(),
        /release merge gate refused/,
      );
    assert.equal(
      harness.calls.filter(({ command }) => command === "bash").length,
      1,
    );
  }
});

test("an ordinary Changesets failure propagates after one attempt", async () => {
  const harness = makeHarness({
    commandResults: [{ status: 1, stdout: "", stderr: "unexpected failure" }],
  });

  await assert.rejects(harness.runtime.version(), /Changesets failed/);
  assert.equal(
    harness.calls.filter(({ command }) => command === process.execPath).length,
    1,
  );
});

test("multiple returned PRs fail closed even when one is from a fork", async () => {
  const harness = makeHarness({
    states: [
      repository({
        pullRequests: [
          releasePullRequest(),
          releasePullRequest({ isCrossRepository: true }),
        ],
      }),
    ],
  });

  await assert.rejects(
    harness.runtime.inspect(),
    /Multiple open release PRs share the release branch/,
  );
  assert.deepEqual(mutationCalls(harness.calls), []);
});

test("read retries are bounded, while mutation failures are never retried", async () => {
  const transientRead = { status: 1, stdout: "", stderr: "HTTP 503" };
  const readHarness = makeHarness({
    extraGhResponses: [transientRead],
  });

  assert.equal(await readHarness.runtime.inspect(), true);
  assert.equal(
    readHarness.calls.filter(({ command }) => command === "gh").length,
    2,
  );
  assert.deepEqual(readHarness.sleeps, [1000]);

  const exhaustedReadHarness = makeHarness({
    extraGhResponses: [transientRead, transientRead, transientRead],
  });
  await assert.rejects(
    exhaustedReadHarness.runtime.inspect(),
    /GitHub request failed/,
  );
  assert.equal(
    exhaustedReadHarness.calls.filter(({ command }) => command === "gh").length,
    3,
  );
  assert.deepEqual(exhaustedReadHarness.sleeps, [1000, 3000]);

  const mutationHarness = makeHarness({
    extraGhResponses: [
      { status: 0, stdout: responseFor(repository()), stderr: "" },
      { status: 1, stdout: "", stderr: "HTTP 500" },
    ],
  });

  await assert.rejects(
    mutationHarness.runtime.cleanup(),
    /GitHub request failed/,
  );
  assert.equal(
    mutationHarness.calls.filter(
      ({ command, args }) => command === "gh" && args[1] === "--method",
    ).length,
    1,
  );
  assert.deepEqual(mutationHarness.sleeps, []);

  const mergeFailureHarness = makeHarness({
    commandResults: [{ status: 1, stdout: "", stderr: "merge gate failed" }],
  });
  await assert.rejects(
    mergeFailureHarness.runtime.merge(),
    /release merge gate refused the handoff/,
  );
  assert.equal(
    mergeFailureHarness.calls.filter(({ command }) => command === "bash")
      .length,
    1,
  );
  assert.deepEqual(mergeFailureHarness.sleeps, []);
});

test("a successful merge handoff receives the exact release PR number", async () => {
  const harness = makeHarness();

  await harness.runtime.merge();

  const mergeCall = harness.calls.find(({ command }) => command === "bash");
  assert.ok(mergeCall);
  assert.equal(mergeCall.options.env.RELEASE_PR_NUMBER, "42");
  assert.equal(
    mergeCall.options.env.RELEASE_MERGE_COMMAND,
    environment.RELEASE_MERGE_COMMAND,
  );
  assert.deepEqual(harness.sleeps, []);
});
