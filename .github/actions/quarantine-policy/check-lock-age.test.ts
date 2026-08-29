import { describe, expect, test } from "bun:test";
import {
  checkNewLockedRegistryReleaseAges,
  readLockedRegistryVersions,
  readNewLockedRegistryVersions,
} from "./check-lock-age";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const lockfile = (...resolutions: string[]) => `{
  "lockfileVersion": 1,
  "packages": {
${resolutions
  .map((resolution, index) => `    "entry-${index}": ["${resolution}", ""]`)
  .join(",\n")}
  }
}`;
const bunfig = (excludes: string) => `[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
${excludes}
]
`;

describe("locked package release age", () => {
  test("finds only newly locked exact registry versions", () => {
    const baseLockfile = lockfile("stable@1.0.0", "changed@1.0.0");
    const currentLockfile = lockfile(
      "stable@1.0.0",
      "changed@2.0.0",
      "@scope/new@3.0.0-beta.1",
      "local@workspace:packages/local",
      "source@git+https://example.com/source.git",
      "changed@2.0.0",
    );
    expect(readLockedRegistryVersions(currentLockfile)).toEqual([
      { name: "@scope/new", version: "3.0.0-beta.1" },
      { name: "changed", version: "2.0.0" },
      { name: "stable", version: "1.0.0" },
    ]);
    expect(
      readNewLockedRegistryVersions({
        baseLockfile,
        lockfile: currentLockfile,
      }),
    ).toEqual([
      { name: "@scope/new", version: "3.0.0-beta.1" },
      { name: "changed", version: "2.0.0" },
    ]);
    expect(() =>
      readLockedRegistryVersions(
        '{"packages":{"package":["package@1.0.0","https://example.com/package.tgz"]}}',
      ),
    ).toThrow("must use the canonical registry source");
  });

  test("rejects a newly locked version inside the release-age window", async () => {
    const metadata = new Map([
      ["aged", { time: { "2.0.0": "2026-08-20T12:00:00.000Z" } }],
      ["fresh", { time: { "2.0.0": "2026-08-28T12:00:00.000Z" } }],
    ]);
    const result = await checkNewLockedRegistryReleaseAges({
      baseLockfile: lockfile("fresh@1.0.0"),
      bunfig: bunfig(`  "allowed", # quarantine-expires: 2026-08-30T00:00:00.000Z
  "exact@2.0.0", # quarantine-expires: 2026-08-30T00:00:00.000Z
  "@stll/internal", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z`),
      loadMetadata: async (name) => {
        const value = metadata.get(name);
        if (value === undefined) throw new Error(`unexpected lookup for ${name}`);
        return value;
      },
      lockfile: lockfile(
        "fresh@2.0.0",
        "aged@2.0.0",
        "allowed@1.0.0",
        "exact@2.0.0",
        "@stll/internal@1.0.0",
      ),
      now: NOW,
    });
    expect(result.checked).toBe(2);
    expect(result.errors).toEqual([
      "fresh@2.0.0: locked version was published at 2026-08-28T12:00:00.000Z and is younger than 432000 seconds",
    ]);
  });

  test("fails closed on missing or unavailable registry timestamps", async () => {
    const result = await checkNewLockedRegistryReleaseAges({
      baseLockfile: lockfile(),
      bunfig: bunfig(""),
      loadMetadata: async (name) => {
        if (name === "missing") return { time: {} };
        throw new Error("registry unavailable");
      },
      lockfile: lockfile("missing@1.0.0", "unavailable@1.0.0"),
      now: NOW,
    });
    expect(result).toEqual({
      checked: 2,
      errors: [
        "missing@1.0.0: npm registry metadata has no publication time",
        "unavailable: registry metadata lookup failed: registry unavailable",
      ],
    });
  });

  test("does not query the registry when the lockfile adds no versions", async () => {
    const unchanged = lockfile("stable@1.0.0");
    const result = await checkNewLockedRegistryReleaseAges({
      baseLockfile: unchanged,
      bunfig: bunfig(""),
      loadMetadata: async () => {
        throw new Error("registry must not be queried");
      },
      lockfile: unchanged,
      now: NOW,
    });
    expect(result).toEqual({ checked: 0, errors: [] });
  });
});
