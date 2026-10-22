import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  checkQuarantinePolicy,
  pruneExpiredExcludes,
  validateCallerWorkflowRefs,
  warningAnnotation,
} from "./check";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const lockfile = '"@stll/native": ["@stll/native@1.0.0", "", {}, "sha512-x"]';
const registryLockfile = (...resolutions: string[]) =>
  JSON.stringify({
    packages: Object.fromEntries(
      resolutions.map((resolution, index) => [index, [resolution, ""]]),
    ),
  });
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
    - cron: "11 4 * * *"
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
      CHANGELOG_APP_ID: \${{ secrets.CHANGELOG_APP_ID }}
      CHANGELOG_APP_PRIVATE_KEY: \${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}
`,
});

describe("quarantine policy", () => {
  test("accepts annotated first-party and active temporary excludes", () => {
    const result = checkQuarantinePolicy({
      bunfig:
        bunfig(`  "@stll/native", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z
  "third-party", # quarantine-expires: 2026-08-30T00:00:00.000Z`),
      lockfile,
      now: NOW,
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  test("allows an exception to be commented out", () => {
    const result = checkQuarantinePolicy({
      bunfig:
        bunfig(`  "@stll/native", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z
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
    expect(alternateRegistry.errors.join("\n")).toContain(
      "canonical npm registry",
    );
    const npmrc = checkQuarantinePolicy({
      bunfig: bunfig(""),
      lockfile: "",
      npmrcPresent: true,
      now: NOW,
    });
    expect(npmrc.errors.join("\n")).toContain(
      "does not allow a repository .npmrc",
    );
  });

  test("uses non-following current npmrc detection", () => {
    const source = readFileSync(
      ".github/actions/quarantine-policy/ecosystems.ts",
      "utf8",
    );
    expect(source).toContain(
      'npmrcPresent: pathEntryExists(path.join(root, ".npmrc"))',
    );
  });

  test("warns for expired exceptions on PR and merge queue events", () => {
    const candidate = bunfig(
      '  "third-party", # quarantine-expires: 2026-08-20T00:00:00.000Z',
    );
    const baseLockfile = registryLockfile("third-party@1.0.0");
    for (const eventName of ["pull_request", "merge_group"]) {
      const input = {
        bunfig: candidate,
        baseBunfig: candidate,
        baseLockfile,
        lockfile: baseLockfile,
        eventName,
        now: NOW,
      };
      const result = checkQuarantinePolicy(input);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(warningAnnotation(result.warnings[0]!)).toStartWith("::warning::");
      const affectingChanges = [
        { lockfile: registryLockfile("third-party@2.0.0") },
        { baseLockfile: registryLockfile() },
        { bunfig: candidate + "# changed config\n" },
        { baseBunfig: undefined },
        { baseNpmrcPresent: true },
      ];
      for (const change of affectingChanges) {
        const changed = checkQuarantinePolicy({ ...input, ...change });
        expect(changed.errors).toEqual([]);
        expect(changed.warnings).toHaveLength(1);
      }
      expect(
        checkQuarantinePolicy({
          ...input,
          lockfile: registryLockfile("third-party@1.0.0", "other@1.0.0"),
        }).errors,
      ).toEqual([]);
      expect(
        checkQuarantinePolicy({
          ...input,
          now: new Date("2027-08-29T12:00:00.000Z"),
        }).errors,
      ).toEqual([]);
    }
  });

  test("expiry warns on main and schedule and can be pruned", () => {
    const candidate = bunfig(
      '  "third-party", # quarantine-expires: 2026-08-29T12:00:00.000Z',
    );
    for (const eventName of ["push", "schedule"]) {
      const input = { bunfig: candidate, lockfile: "", eventName, now: NOW };
      const result = checkQuarantinePolicy(input);
      expect(result.errors).toEqual([]);
      expect(result.warnings.join("\n")).toContain("expired");
      const pruned = pruneExpiredExcludes({ bunfig: candidate, now: NOW });
      expect(pruned.pruned).toEqual(["third-party"]);
      expect(
        checkQuarantinePolicy({ ...input, bunfig: pruned.bunfig }).errors,
      ).toEqual([]);
    }
  });

  test("applies the same change scope to future first-party exclusion dates", () => {
    const candidate = bunfig(
      '  "@stll/native", # quarantine-excluded-since: 2026-08-30T00:00:00.000Z',
    );
    const input = {
      bunfig: candidate,
      baseBunfig: candidate,
      baseLockfile: registryLockfile(),
      lockfile: registryLockfile(),
      now: NOW,
    };
    expect(
      checkQuarantinePolicy({ ...input, eventName: "pull_request" }).warnings,
    ).toHaveLength(1);
    expect(
      checkQuarantinePolicy({ ...input, eventName: "schedule" }).errors,
    ).toHaveLength(1);
    expect(
      checkQuarantinePolicy({
        ...input,
        eventName: "pull_request",
        baseBunfig: bunfig(""),
      }).errors,
    ).toHaveLength(1);
  });

  test("escapes annotation data", () => {
    expect(warningAnnotation("a%\n::error::b\r")).toBe(
      "::warning::a%25%0A::error::b%0D",
    );
  });

  test("prunes only expired temporary excludes", () => {
    const result = pruneExpiredExcludes({
      bunfig:
        bunfig(`  "@stll/native", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z
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
    const result = checkQuarantinePolicy({
      bunfig: bunfig(""),
      lockfile,
      now: NOW,
    });
    expect(result.errors.join("\n")).toContain("@stll/native");
  });

  test("ignores non-registry first-party dependency protocols", () => {
    const localSources = [
      "workspace:packages/foo",
      "file:../foo",
      "link:../foo",
      "git+https://example.com/foo.git",
    ];
    for (const source of localSources) {
      const result = checkQuarantinePolicy({
        bunfig: bunfig(""),
        lockfile: `"@stll/local": ["@stll/local@${source}", "", {}, ""]`,
        now: NOW,
      });
      expect(result.errors).toEqual([]);
    }
  });

  test("allows main push callers without allowing filtered PR or schedule triggers", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "stella/example";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    const withPush = (workflow: string, branches = "[main]") =>
      workflow.replace("on:\n", `on:\n  push:\n    branches: ${branches}\n`);
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository,
        policyWorkflow: withPush(workflows.policyWorkflow),
        pruneWorkflow: withPush(workflows.pruneWorkflow),
      }),
    ).toEqual([]);
    for (const name of ["policyWorkflow", "pruneWorkflow"] as const) {
      expect(
        validateCallerWorkflowRefs({
          expectedRef,
          expectedRepository,
          ...workflows,
          [name]: withPush(workflows[name], "[other]"),
        }).join("\n"),
      ).toContain("restrict push to main");
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

  test("allows self-hosted runner labels on both callers", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "stella/example";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    const withRunsOn = (workflow: string) =>
      workflow.replace(
        "    uses: stella/",
        '    with:\n      runs-on: \'["self-hosted","linux"]\'\n    uses: stella/',
      );
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository,
        policyWorkflow: withRunsOn(workflows.policyWorkflow),
        pruneWorkflow: withRunsOn(workflows.pruneWorkflow),
      }),
    ).toEqual([]);
  });

  test("rejects invalid caller runner inputs", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "stella/example";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    const values = [
      "      runs-on: '[\"self-hosted\"]'\n      extra: true",
      "      runs-on: '\"self-hosted\"'",
      "      runs-on: '[]'",
    ];
    for (const value of values) {
      const policyWorkflow = workflows.policyWorkflow.replace(
        "    uses: stella/",
        `    with:\n${value}\n    uses: stella/`,
      );
      expect(
        validateCallerWorkflowRefs({
          expectedRef,
          expectedRepository,
          policyWorkflow,
          pruneWorkflow: workflows.pruneWorkflow,
        }),
      ).not.toEqual([]);
    }
  });

  test("requires pruning only for stella repositories", () => {
    const expectedRef = "a".repeat(40);
    const stellaWorkflows = callerWorkflows({
      expectedRef,
      expectedRepository: "stella/example",
    });
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository: "stella/example",
        policyWorkflow: stellaWorkflows.policyWorkflow,
      }).join("\n"),
    ).toContain("quarantine-prune.yml is required");

    const externalWorkflows = callerWorkflows({
      expectedRef,
      expectedRepository: "example/project",
    });
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository: "example/project",
        policyWorkflow: externalWorkflows.policyWorkflow,
      }),
    ).toEqual([]);
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository: "example/project",
        policyWorkflow: externalWorkflows.policyWorkflow,
        pruneWorkflow: "not: [valid",
      }).join("\n"),
    ).toContain("must be valid YAML");
  });

  test("accepts exactly one daily prune schedule", () => {
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
  });

  test("rejects a schedule on the policy caller", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "example/project";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    const policyWorkflow = workflows.policyWorkflow.replace(
      "on:\n",
      'on:\n  schedule:\n    - cron: "11 4 * * *"\n',
    );
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        expectedRepository,
        policyWorkflow,
      }).join("\n"),
    ).toContain("must declare only merge_group and pull_request");
  });

  test("rejects caller trigger and condition bypasses", () => {
    const expectedRef = "a".repeat(40);
    const expectedRepository = "stella/example";
    const workflows = callerWorkflows({ expectedRef, expectedRepository });
    const cases = [
      {
        expectedError: "must declare only merge_group and pull_request",
        policyWorkflow: workflows.policyWorkflow.replace(
          "  merge_group:\n",
          "",
        ),
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
          '  schedule:\n    - cron: "11 4 * * *"\n',
          "",
        ),
      },
      {
        expectedError: "must declare one daily schedule",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          "11 4 * * *",
          "11 * * * *",
        ),
      },
      {
        expectedError: "must declare one daily schedule",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          '    - cron: "11 4 * * *"\n',
          '    - cron: "11 4 * * *"\n    - cron: "41 16 * * *"\n',
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
        expectedError:
          "must contain only name, triggers, permissions, and jobs",
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
          "    secrets:\n      CHANGELOG_APP_ID: ${{ secrets.CHANGELOG_APP_ID }}\n      CHANGELOG_APP_PRIVATE_KEY: ${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}\n",
          "    secrets: inherit\n",
        ),
      },
      {
        expectedError: "must pass only the quarantine App secrets",
        pruneWorkflow: workflows.pruneWorkflow.replace(
          "${{ secrets.CHANGELOG_APP_ID }}",
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

  test("runs strict enforcement independently of pruning on schedule and main push", () => {
    const source = readFileSync(
      ".github/workflows/quarantine-prune.yml",
      "utf8",
    );
    const workflow = Bun.YAML.parse(source);
    expect(workflow.concurrency).toEqual({
      "cancel-in-progress": false,
      group: "quarantine-prune-${{ github.repository }}",
    });
    expect(workflow.jobs.prepare.if).toBe(
      "github.repository_owner == 'stella' && (github.event_name == 'schedule' || (github.event_name == 'push' && github.ref == 'refs/heads/main'))",
    );
    expect(workflow.jobs.enforce.needs).toBeUndefined();
    expect(workflow.jobs.prepare.needs).toBeUndefined();
    expect(workflow.jobs.enforce.if).toBe(workflow.jobs.prepare.if);
    expect(workflow.jobs.enforce.uses).toBe(
      "./.github/workflows/quarantine-policy.yml",
    );
    expect(workflow.jobs.propose.if).toBe(
      "(github.event_name == 'schedule' || (github.event_name == 'push' && github.ref == 'refs/heads/main')) && needs.prepare.outputs.changed == 'true'",
    );
    expect(workflow.jobs.prepare.outputs.patch).toBe(
      "${{ steps.patch.outputs.patch }}",
    );
    const encode = workflow.jobs.prepare.steps.find(
      (step: { id?: string }) => step.id === "patch",
    );
    expect(encode.if).toBe("steps.prune.outputs.changed == 'true'");
    const prune = workflow.jobs.prepare.steps.find(
      (step: { id?: string }) => step.id === "prune",
    );
    expect(prune.run).toContain(
      "git diff --binary -- bunfig.toml pnpm-workspace.yaml .cargo/quarantine.toml",
    );
    expect(encode.run).toContain("patch_size > 65536");
    expect(encode.run).toContain("base64 -w0");

    const decode = workflow.jobs.propose.steps.find(
      (step: { name?: string }) => step.name === "Decode exact removal patch",
    );
    expect(decode.env).toEqual({ PATCH: "${{ needs.prepare.outputs.patch }}" });
    expect(decode.run).toContain(
      `printf '%s' "$PATCH" | base64 --decode > "$RUNNER_TEMP/quarantine.patch"`,
    );
    expect(decode.run).not.toContain("${{");
    expect(source).not.toContain("actions/upload-artifact");
    expect(source).not.toContain("actions/download-artifact");
  });

  test("round-trips binary prune patches through the workflow output commands", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(".github/workflows/quarantine-prune.yml", "utf8"),
    );
    const encode = workflow.jobs.prepare.steps.find(
      (step: { id?: string }) => step.id === "patch",
    ).run;
    const decode = workflow.jobs.propose.steps.find(
      (step: { name?: string }) => step.name === "Decode exact removal patch",
    ).run;
    const directory = mkdtempSync(join(tmpdir(), "quarantine-patch-"));
    const output = join(directory, "github-output");

    try {
      writeFileSync(
        join(directory, "quarantine.patch"),
        Buffer.concat([
          Buffer.from("$HOME; $(false); `false`; ' \\"),
          Buffer.from([0xff]),
        ]),
      );

      const encoded = Bun.spawnSync(["bash", "-c", encode], {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: directory },
      });
      expect(encoded.exitCode).toBe(0);
      const expected = readFileSync(join(directory, "quarantine.patch"));
      const outputLine = readFileSync(output, "utf8");
      expect(outputLine).toMatch(/^patch=[A-Za-z0-9+/=]+\n$/);
      unlinkSync(join(directory, "quarantine.patch"));

      const decoded = Bun.spawnSync(["bash", "-c", decode], {
        cwd: directory,
        env: {
          ...process.env,
          PATCH: outputLine.trimEnd().slice("patch=".length),
          RUNNER_TEMP: directory,
        },
      });
      expect(decoded.exitCode).toBe(0);
      expect(readFileSync(join(directory, "quarantine.patch"))).toEqual(
        expected,
      );
      expect(expected.includes(0xff)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("checks newly locked versions against the trusted merge base", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(".github/workflows/quarantine-policy.yml", "utf8"),
    );
    const checkout = workflow.jobs.enforce.steps.find(
      (step: { name?: string }) => step.name === "Checkout trusted target base",
    );
    expect(checkout?.if).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
    );
    expect(checkout?.with).toEqual({
      path: ".quarantine-base",
      "persist-credentials": false,
      ref: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
      "sparse-checkout":
        "bun.lock\nbunfig.toml\npackage.json\npnpm-lock.yaml\npnpm-workspace.yaml\n.npmrc\n.cargo/quarantine.toml\n.cargo/config.toml\n**/Cargo.lock\n",
      "sparse-checkout-cone-mode": false,
    });
    const lockAge = workflow.jobs.enforce.steps.find(
      (step: { name?: string }) =>
        step.name === "Enforce newly locked package ages",
    );
    expect(lockAge?.run).toContain("check-lock-age.ts");
    expect(lockAge?.run).toContain(".quarantine-base/bun.lock");
    expect(lockAge?.run).toContain(".quarantine-base/bunfig.toml");
    expect(lockAge?.run).toContain(".quarantine-base/.npmrc");
  });
});
