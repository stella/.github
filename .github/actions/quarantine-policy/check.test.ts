import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  checkQuarantinePolicy,
  pruneExpiredExcludes,
  validateCallerWorkflowRefs,
} from "./check";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const lockfile = '"@stll/native": ["@stll/native@1.0.0", "", {}, "sha512-x"]';
const bunfig = (entries: string) => `[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
${entries}
]
`;
const callerWorkflows = ({
  expectedRef,
  expectedRepository,
}: {
  expectedRef: string;
  expectedRepository: string;
}) => ({
  policyWorkflow: `name: Package quarantine policy
on:
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  enforce:
    name: Enforce package quarantine
    if: github.repository == '${expectedRepository}'
    permissions:
      contents: read
    uses: stella/.github/.github/workflows/quarantine-policy.yml@${expectedRef}
`,
  pruneWorkflow: `name: Package quarantine prune
on:
  schedule:
    - cron: "17 * * * *"
permissions:
  contents: read
jobs:
  prune:
    name: Remove expired quarantine exceptions
    if: github.repository == '${expectedRepository}'
    permissions:
      contents: read
    uses: stella/.github/.github/workflows/quarantine-prune.yml@${expectedRef}
    secrets:
      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}
`,
});

describe("quarantine policy", () => {
  test("accepts annotated first-party and active temporary excludes", () => {
    const result = checkQuarantinePolicy({
      bunfig: bunfig(`  "@stll/native", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z
  "third-party", # quarantine-expires: 2026-08-30T00:00:00.000Z`),
      lockfile,
      now: NOW,
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  test("allows an exception to be commented out", () => {
    const result = checkQuarantinePolicy({
      bunfig: bunfig(`  "@stll/native", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z
  # "third-party", # quarantine-expires: 2026-08-30T00:00:00.000Z`),
      lockfile,
      now: NOW,
    });
    expect(result.errors).toEqual([]);
  });

  test("rejects floating policy and unannotated excludes", () => {
    const result = checkQuarantinePolicy({
      bunfig: `[install]\nminimumReleaseAge = 0\nminimumReleaseAgeExcludes = ["third-party"]`,
      lockfile: "",
      now: NOW,
    });
    expect(result.errors.join("\n")).toContain("minimumReleaseAge = 432000");
  });

  test("rejects registry configuration that can bypass npm publication age", () => {
    const alternateRegistry = checkQuarantinePolicy({
      bunfig: `${bunfig("")}registry = "https://registry.example.com"\n`,
      lockfile: "",
      now: NOW,
    });
    expect(alternateRegistry.errors.join("\n")).toContain("canonical npm registry");
    const npmrc = checkQuarantinePolicy({
      bunfig: bunfig(""),
      lockfile: "",
      npmrcPresent: true,
      now: NOW,
    });
    expect(npmrc.errors.join("\n")).toContain("does not allow a repository .npmrc");
  });

  test("warns briefly, then rejects an expired temporary exclude", () => {
    const candidate = bunfig(
      '  "third-party", # quarantine-expires: 2026-08-29T11:00:00.000Z',
    );
    expect(checkQuarantinePolicy({ bunfig: candidate, lockfile: "", now: NOW }).warnings).toHaveLength(1);
    expect(
      checkQuarantinePolicy({
        bunfig: candidate,
        lockfile: "",
        now: new Date("2026-08-30T12:00:00.001Z"),
      }).errors.join("\n"),
    ).toContain("expired");
  });

  test("prunes only expired temporary excludes", () => {
    const result = pruneExpiredExcludes({
      bunfig: bunfig(`  "@stll/native", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z
  "expired", # quarantine-expires: 2026-08-29T11:00:00.000Z
  "active", # quarantine-expires: 2026-08-30T00:00:00.000Z`),
      now: NOW,
    });
    expect(result.pruned).toEqual(["expired"]);
    expect(result.bunfig).not.toContain('"expired"');
    expect(result.bunfig).toContain('"active"');
    expect(result.bunfig).toContain('"@stll/native"');
  });

  test("requires every registry-backed first-party package", () => {
    const result = checkQuarantinePolicy({ bunfig: bunfig(""), lockfile, now: NOW });
    expect(result.errors.join("\n")).toContain("@stll/native");
  });

  test("ignores non-registry first-party dependency protocols", () => {
    const localSources = ["workspace:packages/foo", "file:../foo", "link:../foo", "git+https://example.com/foo.git"];
    for (const source of localSources) {
      const result = checkQuarantinePolicy({
        bunfig: bunfig(""),
        lockfile: `"@stll/local": ["@stll/local@${source}", "", {}, ""]`,
        now: NOW,
      });
      expect(result.errors).toEqual([]);
    }
  });

  test("binds both caller workflows to the exact shared revision and repository", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "stella/example";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository,
        ...workflows,
      }),
    ).toEqual([]);

    const spoofedPolicy = workflows.policyWorkflow.replace(
      `stella/.github/.github/workflows/quarantine-policy.yml@${expectedRef}`,
      `evil/repo/.github/workflows/policy.yml@main # stella/.github/.github/workflows/quarantine-policy.yml@${expectedRef}`,
    );
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository,
        policyWorkflow: spoofedPolicy,
        pruneWorkflow: workflows.pruneWorkflow,
      }).join("\n"),
    ).toContain("must use");
  });

  test("rejects caller trigger and condition bypasses", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "stella/example";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    const cases = [
      {
        expectedError: "must declare only merge_group and pull_request",
        policyWorkflow: workflows.policyWorkflow.replace("  merge_group:\n", ""),
      },
      {
        expectedError: "must declare only merge_group and pull_request",
        policyWorkflow: workflows.policyWorkflow.replace(
          "  merge_group:\n",
          "  merge_group:\n  workflow_dispatch:\n",
        ),
      },
      {
        expectedError: "must not filter enforcement triggers",
        policyWorkflow: workflows.policyWorkflow.replace(
          "  pull_request:\n",
          "  pull_request:\n    branches: [main]\n",
        ),
      },
      {
        expectedError: "must use only the exact repository guard",
        policyWorkflow: workflows.policyWorkflow.replace(
          `github.repository == '${expectedRepository}'`,
          "github.event_name == 'pull_request'",
        ),
      },
      {
        expectedError: "must contain only the canonical caller job fields",
        policyWorkflow: workflows.policyWorkflow.replace(
          "    permissions:\n",
          "    continue-on-error: true\n    permissions:\n",
        ),
      },
      {
        expectedError: "must declare only schedule",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          "permissions:\n",
          "  workflow_dispatch:\npermissions:\n",
        ),
      },
      {
        expectedError: "must declare required triggers",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          "  schedule:\n    - cron: \"17 * * * *\"\n",
          "",
        ),
      },
      {
        expectedError: "must declare one hourly schedule",
        pruneWorkflow: workflows.pruneWorkflow.replace("17 * * * *", "17 0 * * *"),
      },
      {
        expectedError: "must declare one hourly schedule",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          "    - cron: \"17 * * * *\"\n",
          "    - cron: \"17 * * * *\"\n    - cron: \"47 * * * *\"\n",
        ),
      },
      {
        expectedError: "must use only the exact repository guard",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          `github.repository == '${expectedRepository}'`,
          "github.event_name == 'schedule'",
        ),
      },
    ];

    for (const { expectedError, policyWorkflow, pruneWorkflow } of cases) {
      const candidatePolicy = policyWorkflow ?? workflows.policyWorkflow;
      const candidatePrune = pruneWorkflow ?? workflows.pruneWorkflow;
      expect([candidatePolicy, candidatePrune]).not.toEqual([
        workflows.policyWorkflow,
        workflows.pruneWorkflow,
      ]);
      expect(
        validateCallerWorkflowRefs({
          expectedRef,
          expectedRepository,
          policyWorkflow: candidatePolicy,
          pruneWorkflow: candidatePrune,
        }).join("\n"),
      ).toContain(expectedError);
    }
  });

  test("rejects widened caller structure, permissions, and secrets", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "stella/example";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    const cases = [
      {
        expectedError: "must contain only name, triggers, permissions, and jobs",
        policyWorkflow: workflows.policyWorkflow.replace(
          "permissions:\n",
          "concurrency: quarantine-policy\npermissions:\n",
        ),
      },
      {
        expectedError: "must grant only contents read",
        policyWorkflow: workflows.policyWorkflow.replace(
          "permissions:\n  contents: read\n",
          "permissions:\n  contents: write\n",
        ),
      },
      {
        expectedError: "caller job must grant only contents read",
        policyWorkflow: workflows.policyWorkflow.replace(
          "    permissions:\n      contents: read\n",
          "    permissions:\n      contents: write\n",
        ),
      },
      {
        expectedError: "must declare one caller job",
        policyWorkflow: `${workflows.policyWorkflow}  bypass:\n    uses: evil/repo/.github/workflows/bypass.yml@main\n`,
      },
      {
        expectedError: "must pass only the quarantine App secrets",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          "    secrets:\n      RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}\n      RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}\n",
          "    secrets: inherit\n",
        ),
      },
      {
        expectedError: "must pass only the quarantine App secrets",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          "${{ secrets.RELEASE_APP_ID }}",
          "${{ secrets.NPM_TOKEN }}",
        ),
      },
    ];

    for (const { expectedError, policyWorkflow, pruneWorkflow } of cases) {
      const candidatePolicy = policyWorkflow ?? workflows.policyWorkflow;
      const candidatePrune = pruneWorkflow ?? workflows.pruneWorkflow;
      expect([candidatePolicy, candidatePrune]).not.toEqual([
        workflows.policyWorkflow,
        workflows.pruneWorkflow,
      ]);
      expect(
        validateCallerWorkflowRefs({
          expectedRef,
          expectedRepository,
          policyWorkflow: candidatePolicy,
          pruneWorkflow: candidatePrune,
        }).join("\n"),
      ).toContain(expectedError);
    }
  });

  test("gates reusable pruning and App credentials on the runtime schedule event", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(".github/workflows/quarantine-prune.yml", "utf8"),
    );
    expect(workflow.concurrency).toEqual({
      "cancel-in-progress": false,
      group: "quarantine-prune-${{ github.repository }}",
    });
    expect(workflow.jobs.prepare.if).toBe(
      "github.repository_owner == 'stella' && github.event_name == 'schedule'",
    );
    expect(workflow.jobs.propose.if).toBe(
      "github.event_name == 'schedule' && needs.prepare.outputs.changed == 'true'",
    );
  });

  test("checks newly locked versions against the trusted merge base", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(".github/workflows/quarantine-policy.yml", "utf8"),
    );
    const checkout = workflow.jobs.enforce.steps.find(
      (step: { name?: string }) => step.name === "Checkout caller",
    );
    expect(checkout?.with).toEqual({
      "fetch-depth": 2,
      "persist-credentials": false,
    });
    const lockAge = workflow.jobs.enforce.steps.find(
      (step: { name?: string }) => step.name === "Enforce newly locked package ages",
    );
    expect(lockAge?.run).toContain("git show HEAD^1:bun.lock");
    expect(lockAge?.run).toContain("check-lock-age.ts");
  });
});
