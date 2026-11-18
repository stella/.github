import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNewLockedRegistryReleaseAges,
  readLockedRegistryVersions,
  readNewLockedRegistryVersions,
} from "./check-lock-age";
import { pathEntryExists } from "./check";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const CHECK_ENTRY = join(import.meta.dir, "check-lock-age.ts");
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

const runNestedRootCheck = (nestedExcludes = "") => {
  const directory = mkdtempSync(join(tmpdir(), "quarantine-lock-age-roots-"));
  const nestedRoot = join(directory, "plugins/vscode");
  const baseNestedRoot = join(directory, ".quarantine-base/plugins/vscode");
  mkdirSync(nestedRoot, { recursive: true });
  mkdirSync(baseNestedRoot, { recursive: true });
  writeFileSync(join(directory, "bun.lock"), lockfile("old-root@2.0.0"));
  writeFileSync(join(directory, "bunfig.toml"), bunfig(""));
  writeFileSync(join(nestedRoot, "bun.lock"), lockfile("young-nested@2.0.0"));
  writeFileSync(join(nestedRoot, "bunfig.toml"), bunfig(nestedExcludes));
  writeFileSync(join(directory, ".quarantine-base/bun.lock"), lockfile());
  writeFileSync(join(directory, ".quarantine-base/bunfig.toml"), bunfig(""));
  writeFileSync(join(baseNestedRoot, "bun.lock"), lockfile());
  writeFileSync(join(baseNestedRoot, "bunfig.toml"), bunfig(""));
  spawnSync("git", ["init", "-q"], { cwd: directory });
  spawnSync("git", ["add", "bun.lock", "plugins/vscode/bun.lock"], {
    cwd: directory,
  });
  const preload = join(directory, "registry-fixture.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (input) => {
  const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
  const published = name === "old-root"
    ? "2020-01-01T00:00:00.000Z"
    : new Date(Date.now() - 86_400_000).toISOString();
  return Response.json({ time: { "2.0.0": published } });
};\n`,
  );
  const result = spawnSync(
    "bun",
    [
      "--preload",
      preload,
      CHECK_ENTRY,
      ".quarantine-base/bun.lock",
      ".quarantine-base/bunfig.toml",
      ".quarantine-base/.npmrc",
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        BUN_ROOTS: ". plugins/vscode",
        GITHUB_EVENT_NAME: "pull_request",
      },
    },
  );
  rmSync(directory, { force: true, recursive: true });
  return result;
};

describe("registry metadata retries", () => {
  for (const registry of ["npm", "cargo"] as const) {
    for (const scenario of ["recover", "exhaust", "terminal-http"] as const) {
      test(`${registry} ${scenario} preserves the bounded registry retry policy`, () => {
        const script = `
        import { loadRegistryMetadata, loadCargoRegistryText } from ${JSON.stringify(CHECK_ENTRY)};
        const scenario = ${JSON.stringify(scenario)};
        const registry = ${JSON.stringify(registry)};
        let calls = 0;
        globalThis.fetch = async () => {
          calls++;
          if (scenario === "terminal-http") return new Response(null, { status: 404 });
          if (scenario === "recover" && calls > 1) return Response.json({ time: { "1.0.0": "2020-01-01T00:00:00.000Z" } });
          return new Response(new ReadableStream({
            start(controller) {
              controller.error(new DOMException("metadata body timed out", "TimeoutError"));
            },
          }));
        };
        try {
          const metadata = registry === "npm"
            ? await loadRegistryMetadata("retry-fixture")
            : JSON.parse(await loadCargoRegistryText("https://index.crates.io/re/tr/retry-fixture"));
          console.log(JSON.stringify({ calls, metadata }));
        } catch (error) {
          console.log(JSON.stringify({ calls, error: error.message }));
        }
      `;
        const result = spawnSync("bun", ["--eval", script], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status).toBe(0);
        const value = JSON.parse(result.stdout);
        if (scenario === "recover") {
          expect(value).toEqual({
            calls: 2,
            metadata: { time: { "1.0.0": "2020-01-01T00:00:00.000Z" } },
          });
        } else {
          expect(value).toEqual({
            calls: scenario === "exhaust" || registry === "cargo" ? 3 : 1,
            error:
              scenario === "exhaust"
                ? "metadata body timed out"
                : registry === "npm"
                  ? "npm registry returned HTTP 404"
                  : "HTTP 404",
          });
        }
      });
    }
  }
});

describe("locked package release age", () => {
  test("screens newly locked versions in every declared Bun root", () => {
    const result = runNestedRootCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "plugins/vscode/bun.lock: young-nested@2.0.0",
    );
    expect(result.stderr).not.toContain("old-root@2.0.0");
  });

  test("accepts an active nested-root release-age exception", () => {
    const result = runNestedRootCheck(
      '  "young-nested@2.0.0", # quarantine-expires: 2026-10-23T00:00:00.000Z',
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "validated 1 newly locked registry version(s)",
    );
  });

  test("detects a base npmrc symlink without following its target", () => {
    const directory = mkdtempSync(join(tmpdir(), "quarantine-lock-age-"));
    try {
      const npmrc = join(directory, ".npmrc");
      symlinkSync("missing-target", npmrc);
      expect(pathEntryExists(npmrc)).toBe(true);
      expect(pathEntryExists(join(directory, "absent"))).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

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
      bunfig:
        bunfig(`  "allowed", # quarantine-expires: 2026-08-30T00:00:00.000Z
  "exact@2.0.0", # quarantine-expires: 2026-08-30T00:00:00.000Z
  "@stll/internal", # quarantine-excluded-since: 2026-08-20T00:00:00.000Z`),
      loadMetadata: async (name) => {
        const value = metadata.get(name);
        if (value === undefined)
          throw new Error(`unexpected lookup for ${name}`);
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

  test("checks every version when the trusted base has no lockfile", async () => {
    const result = await checkNewLockedRegistryReleaseAges({
      bunfig: bunfig(""),
      loadMetadata: async () => ({
        time: { "1.0.0": "2026-08-20T12:00:00.000Z" },
      }),
      lockfile: lockfile("first@1.0.0"),
      now: NOW,
    });
    expect(result).toEqual({ checked: 1, errors: [] });
  });

  test("checks every version when the base has no valid quarantine policy", async () => {
    const unchanged = lockfile("existing@1.0.0");
    const result = await checkNewLockedRegistryReleaseAges({
      baseBunfig: "[install]\nregistry = 'https://registry.npmjs.org'\n",
      baseLockfile: unchanged,
      bunfig: bunfig(""),
      loadMetadata: async () => ({
        time: { "1.0.0": "2026-08-20T12:00:00.000Z" },
      }),
      lockfile: unchanged,
      now: NOW,
    });
    expect(result).toEqual({ checked: 1, errors: [] });
  });

  test("checks every version when the base has a repository npmrc", async () => {
    const unchanged = lockfile("alternate-registry@1.0.0");
    const result = await checkNewLockedRegistryReleaseAges({
      baseBunfig: bunfig(""),
      baseLockfile: unchanged,
      baseNpmrcPresent: true,
      bunfig: bunfig(""),
      loadMetadata: async () => ({
        time: { "1.0.0": "2026-08-20T12:00:00.000Z" },
      }),
      lockfile: unchanged,
      now: NOW,
    });
    expect(result).toEqual({ checked: 1, errors: [] });
  });

  test("rechecks an unchanged version when its base exception is removed", async () => {
    const unchanged = lockfile("fresh@1.0.0", "still-allowed@1.0.0");
    const result = await checkNewLockedRegistryReleaseAges({
      baseBunfig:
        bunfig(`  "fresh", # quarantine-expires: 2026-08-28T00:00:00.000Z
  "still-allowed", # quarantine-expires: 2026-08-30T00:00:00.000Z`),
      baseLockfile: unchanged,
      bunfig: bunfig(
        `  "still-allowed", # quarantine-expires: 2026-08-30T00:00:00.000Z`,
      ),
      loadMetadata: async (name) => ({
        time: { "1.0.0": "2026-08-28T12:00:00.000Z" },
        name,
      }),
      lockfile: unchanged,
      now: NOW,
    });
    expect(result).toEqual({
      checked: 1,
      errors: [
        "fresh@1.0.0: locked version was published at 2026-08-28T12:00:00.000Z and is younger than 432000 seconds",
      ],
    });
  });

  test("fails closed on missing or unavailable registry timestamps", async () => {
    const result = await checkNewLockedRegistryReleaseAges({
      baseLockfile: lockfile(),
      bunfig: bunfig(""),
      loadMetadata: async (name) => {
        if (name === "missing") return { time: {} };
        if (name === "malformed") return { time: { "1.0.0": "0" } };
        throw new Error("registry unavailable");
      },
      lockfile: lockfile(
        "malformed@1.0.0",
        "missing@1.0.0",
        "unavailable@1.0.0",
      ),
      now: NOW,
    });
    expect(result).toEqual({
      checked: 3,
      errors: [
        "malformed@1.0.0: npm registry returned an invalid publication time",
        "missing@1.0.0: npm registry metadata has no publication time",
        "unavailable: registry metadata lookup failed: registry unavailable",
      ],
    });
  });

  test("admits versions exactly at the injected five-day cutoff", async () => {
    const result = await checkNewLockedRegistryReleaseAges({
      bunfig: bunfig(""),
      lockfile: lockfile("boundary@1.0.0", "boundary@2.0.0"),
      now: NOW,
      loadMetadata: async () => ({
        time: {
          "1.0.0": "2026-08-24T12:00:00.000Z",
          "2.0.0": "2026-08-24T12:00:00.001Z",
        },
      }),
    });
    expect(result.checked).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith("boundary@2.0.0:");
  });

  test("inherited expired exclusions do not trigger registry lookups on unrelated PRs", async () => {
    const config = bunfig(
      '  "allowed", # quarantine-expires: 2026-08-20T00:00:00.000Z',
    );
    for (const eventName of ["pull_request", "merge_group"]) {
      const result = await checkNewLockedRegistryReleaseAges({
        baseBunfig: config,
        bunfig: config,
        baseLockfile: lockfile("allowed@1.0.0", "stable@1.0.0"),
        lockfile: lockfile("allowed@1.0.0", "stable@1.0.0"),
        eventName,
        now: NOW,
        loadMetadata: async () => {
          throw new Error("unexpected lookup");
        },
      });
      expect(result).toEqual({ checked: 0, errors: [] });
    }
  });

  test("config changes and maintenance events recheck existing non-excluded versions", async () => {
    for (const eventName of [
      "pull_request",
      "merge_group",
      "push",
      "schedule",
    ]) {
      const result = await checkNewLockedRegistryReleaseAges({
        baseBunfig: bunfig(""),
        bunfig:
          bunfig("") +
          (eventName === "pull_request" || eventName === "merge_group"
            ? "# changed\n"
            : ""),
        baseLockfile: lockfile("fresh@1.0.0"),
        lockfile: lockfile("fresh@1.0.0"),
        eventName,
        now: NOW,
        loadMetadata: async () => ({
          time: { "1.0.0": "2026-08-28T12:00:00.000Z" },
        }),
      });
      expect(result.checked).toBe(1);
      expect(result.errors.join("\n")).toContain("younger than");
    }
  });

  test("does not query the registry when the lockfile adds no versions", async () => {
    const unchanged = lockfile("stable@1.0.0");
    const result = await checkNewLockedRegistryReleaseAges({
      baseBunfig: bunfig(""),
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
