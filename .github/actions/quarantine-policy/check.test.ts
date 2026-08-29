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

  test("binds both caller workflows to the exact shared revision", () => {
    const expectedRef = "a".repeat(40);
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        policyWorkflow: `uses: stella/.github/.github/workflows/quarantine-policy.yml@${expectedRef}`,
        pruneWorkflow: `uses: stella/.github/.github/workflows/quarantine-prune.yml@${expectedRef}`,
      }),
    ).toEqual([]);
    expect(
      validateCallerWorkflowRefs({
        expectedRef,
        policyWorkflow: "uses: stella/.github/.github/workflows/quarantine-policy.yml@main",
        pruneWorkflow: `uses: stella/.github/.github/workflows/quarantine-prune.yml@${expectedRef}`,
      }).join("\n"),
    ).toContain("must use");
  });
});
