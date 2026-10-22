import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkBunTrustedDependencies,
  checkCargoPolicy,
  checkPnpmPolicy,
  checkRepositoryPolicy,
  classifyCargoSource,
  pruneRepositoryExcludes,
  readCargoPackages,
  readPnpmLockedRegistryVersions,
} from "./ecosystems";
import { checkNewCargoReleaseAges, cratesIndexPath } from "./check-lock-age";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const pnpmLock = `lockfileVersion: '9.0'\npackages:\n  foo@1.2.3(peer@2.0.0): {}\n  '@scope/bar@2.0.0': {}\n`;
const workspace = `minimumReleaseAge: 7200\nminimumReleaseAgeExclude:\n  - "hotfix@1.0.0" # quarantine-expires: 2026-08-30T12:00:00.000Z\nonlyBuiltDependencies:\n  - foo\n`;
const cargoLock = (
  source = "registry+https://github.com/rust-lang/crates.io-index",
) =>
  `version = 3\n[[package]]\nname = "crate"\nversion = "1.0.0"\nsource = "${source}"\n[[package]]\nname = "local"\nversion = "0.1.0"\n`;
const cargoGitLock = (name: string, source: string) =>
  `[[package]]\nname = "${name}"\nversion = "1.0.0"\nsource = "${source}"\n`;
const quarantine = (
  entry = '"crate@1.0.0", # quarantine-expires: 2026-08-30T12:00:00.000Z',
) => `excludes = [\n  ${entry}\n]\n`;

test("Bun requires explicit, current trusted dependencies", () => {
  const lock = '{"packages":{"foo":["foo@1.0.0",""]}}';
  expect(checkBunTrustedDependencies("{}", lock).join("\n")).toContain(
    "must declare",
  );
  expect(
    checkBunTrustedDependencies(
      '{"trustedDependencies":["missing"]}',
      lock,
    ).join("\n"),
  ).toContain("missing package");
  expect(
    checkBunTrustedDependencies('{"trustedDependencies":["foo"]}', lock),
  ).toEqual([]);
});

test("detects unsupported locks and unlocked manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-detect-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "package.json"), "{}");
    spawnSync("git", ["add", "package.json"], { cwd: root });
    expect(
      checkRepositoryPolicy({ root, eventName: "push", now: NOW }).errors.join(
        "\n",
      ),
    ).toContain("unlocked");
    writeFileSync(join(root, "yarn.lock"), "");
    spawnSync("git", ["add", "yarn.lock"], { cwd: root });
    expect(
      checkRepositoryPolicy({ root, eventName: "push", now: NOW }).errors.join(
        "\n",
      ),
    ).toContain("unsupported lockfiles");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a dangling repository .npmrc symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-npmrc-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(
      join(root, "bunfig.toml"),
      "[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = []\n",
    );
    writeFileSync(join(root, "bun.lock"), '{"packages":{}}');
    writeFileSync(join(root, "package.json"), '{"trustedDependencies":[]}');
    symlinkSync("missing-npmrc", join(root, ".npmrc"));
    spawnSync("git", ["add", "bunfig.toml", "bun.lock", "package.json"], {
      cwd: root,
    });
    expect(
      checkRepositoryPolicy({ root, eventName: "push", now: NOW }).errors.join(
        "\n",
      ),
    ).toContain("does not allow a repository .npmrc");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prunes expired entries from all ecosystem files", () => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-prune-"));
  try {
    mkdirSync(join(root, ".cargo"));
    const marker =
      '"old@1.0.0", # quarantine-expires: 2026-08-20T00:00:00.000Z';
    writeFileSync(
      join(root, "bunfig.toml"),
      `[install]\nminimumReleaseAgeExcludes = [\n  ${marker}\n]`,
    );
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      `minimumReleaseAgeExclude:\n  - ${marker}\n`,
    );
    writeFileSync(
      join(root, ".cargo/quarantine.toml"),
      `excludes = [\n  ${marker}\n  "prefix-old@1.0.0", # quarantine-expires: 2026-09-01T00:00:00.000Z\n]`,
    );
    expect(pruneRepositoryExcludes({ root, now: NOW })).toBe(3);
    for (const file of [
      "bunfig.toml",
      "pnpm-workspace.yaml",
      ".cargo/quarantine.toml",
    ])
      expect(readFileSync(join(root, file), "utf8")).not.toContain(
        '"old@1.0.0"',
      );
    expect(
      readFileSync(join(root, ".cargo/quarantine.toml"), "utf8"),
    ).toContain("prefix-old@1.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pnpm quarantine", () => {
  test("parses v9 keys and strips peer suffixes", () =>
    expect(readPnpmLockedRegistryVersions(pnpmLock)).toEqual([
      { name: "@scope/bar", version: "2.0.0" },
      { name: "foo", version: "1.2.3" },
    ]));
  test("accepts valid policy and rejects unsafe build configuration", () => {
    const input = {
      workspace,
      lockfile: pnpmLock,
      packageJson: '{"packageManager":"pnpm@10.16.0"}',
      now: NOW,
    };
    expect(checkPnpmPolicy(input).errors).toEqual([]);
    expect(
      checkPnpmPolicy({
        ...input,
        workspace: workspace + "dangerouslyAllowAllBuilds: true\n",
      }).errors.join("\n"),
    ).toContain("dangerouslyAllowAllBuilds");
    expect(
      checkPnpmPolicy({
        ...input,
        packageJson: '{"packageManager":"pnpm@10.15.0"}',
      }).errors.join("\n"),
    ).toContain("10.16.0");
  });
  test("warns for expired exceptions on push and schedule", () => {
    const expiredWorkspace = workspace.replace(
      "2026-08-30T12:00:00.000Z",
      "2026-08-20T12:00:00.000Z",
    );
    for (const eventName of ["push", "schedule"]) {
      const result = checkPnpmPolicy({
        workspace: expiredWorkspace,
        lockfile: pnpmLock,
        packageJson: '{"packageManager":"pnpm@10.16.0"}',
        eventName,
        now: NOW,
      });
      expect(result.errors).toEqual([]);
      expect(result.warnings.join("\n")).toContain("expired");
    }
  });
  test("requires every exclusion shape to be an annotated double-quoted line", () => {
    const input = {
      workspace,
      lockfile: pnpmLock,
      packageJson: '{"packageManager":"pnpm@10.16.0"}',
      now: NOW,
    };
    for (const declaration of [
      "minimumReleaseAgeExclude:\n  - hotfix@1.0.0\n",
      'minimumReleaseAgeExclude: ["hotfix@1.0.0"]\n',
      "minimumReleaseAgeExclude:\n  - 42\n",
    ]) {
      expect(
        checkPnpmPolicy({
          ...input,
          workspace: `minimumReleaseAge: 7200\n${declaration}`,
        }).errors.join("\n"),
      ).toContain("must declare one annotated package per line");
    }
  });
  test("fails closed for non-registry package resolutions unless exactly excluded", () => {
    for (const resolution of [
      "https://codeload.github.com/example/pkg/tar.gz/abc",
      "git+https://github.com/example/pkg.git#abc",
    ]) {
      const lockfile = `lockfileVersion: '9.0'\npackages:\n  'foo@${resolution}': {}\n`;
      expect(() => readPnpmLockedRegistryVersions(lockfile)).toThrow(
        "non-registry",
      );
      expect(
        readPnpmLockedRegistryVersions(lockfile, [`foo@${resolution}`]),
      ).toEqual([]);
    }
  });
});

describe("Cargo quarantine", () => {
  test("allows crates.io and path members but rejects git and alternate registries", () => {
    const input = {
      quarantine: quarantine(),
      config: '[registry]\nglobal-min-publish-age = "5 days"',
      lockfiles: new Map([["Cargo.lock", cargoLock()]]),
      now: NOW,
    };
    expect(checkCargoPolicy(input).errors).toEqual([]);
    for (const source of [
      "git+https://example.com/repo",
      "registry+https://example.com/index",
    ]) {
      expect(
        checkCargoPolicy({
          ...input,
          quarantine: "excludes = []",
          lockfiles: new Map([["Cargo.lock", cargoLock(source)]]),
        }).errors.join("\n"),
      ).toContain("unsupported source");
    }
    expect(
      readCargoPackages(cargoLock()).find((p) => p.name === "local")?.source,
    ).toBeUndefined();
  });
  test("classifies pinned first-party git sources", () => {
    const commit = "50798ef8f962f41e2cba1539e85b8f41605a7e71";
    expect(
      classifyCargoSource(
        "stella-stdnum",
        `git+https://github.com/stella/stdnum?tag=v2.1.3#${commit}`,
      ),
    ).toEqual({ kind: "first-party-git", repository: "stdnum", commit });
    expect(
      classifyCargoSource(
        "stella_internal",
        `git+https://github.com/stella/internal?rev=${commit}#${commit}`,
      ),
    ).toEqual({ kind: "first-party-git", repository: "internal", commit });
  });
  test("rejects non-canonical or unpinned first-party git sources", () => {
    const commit = "50798ef8f962f41e2cba1539e85b8f41605a7e71";
    const secureShellSource = "git+ssh://git" + `@github.com/stella/x#${commit}`;
    for (const [name, source] of [
      ["stella-x", `git+https://github.com/other/x#${commit}`],
      ["stella-x", secureShellSource],
      ["stella-x", `git+http://github.com/stella/x#${commit}`],
      ["stella-x", `git+https://github.com/stella/x/y#${commit}`],
      ["stella-x", "git+https://github.com/stella/x#50798ef8f962"],
      ["stella-x", "git+https://github.com/stella/x"],
      ["stella-x", `git+https://github.com/stella/x#${commit.toUpperCase()}`],
      ["stella-x", `git+https://github.com/stella/..#${commit}`],
      ["serde", `git+https://github.com/stella/serde#${commit}`],
    ] as const) {
      expect(classifyCargoSource(name, source)).toEqual({
        kind: "unsupported",
        source,
      });
    }
  });
  test("never classifies random non-stella owners as first-party git", () => {
    const commit = "50798ef8f962f41e2cba1539e85b8f41605a7e71";
    let state = 0x50798ef8;
    for (let iteration = 0; iteration < 100; iteration++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const owner = `owner-${state.toString(36)}`;
      expect(
        classifyCargoSource(
          "stella-random",
          `git+https://github.com/${owner}/repo#${commit}`,
        ).kind,
      ).not.toBe("first-party-git");
    }
  });
  test("accepts pinned first-party git crates without quarantine entries", () => {
    const commit = "50798ef8f962f41e2cba1539e85b8f41605a7e71";
    const lockfile = [
      cargoGitLock(
        "stella-stdnum",
        `git+https://github.com/stella/stdnum?tag=v2.1.3#${commit}`,
      ),
      cargoGitLock(
        "stella_internal",
        `git+https://github.com/stella/internal?rev=${commit}#${commit}`,
      ),
    ].join("\n");
    expect(
      checkCargoPolicy({
        quarantine: "excludes = []",
        config: '[registry]\nglobal-min-publish-age = "5 days"',
        lockfiles: new Map([["Cargo.lock", lockfile]]),
        now: NOW,
      }).errors,
    ).toEqual([]);
  });
  test("does not release-age screen pinned first-party git crates", async () => {
    const commit = "50798ef8f962f41e2cba1539e85b8f41605a7e71";
    const result = await checkNewCargoReleaseAges({
      lockfiles: new Map([
        [
          "Cargo.lock",
          cargoGitLock(
            "stella-stdnum",
            `git+https://github.com/stella/stdnum?tag=v2.1.3#${commit}`,
          ),
        ],
      ]),
      loadApi: async () => {
        throw new Error("unexpected crates.io API lookup");
      },
      loadIndex: async () => {
        throw new Error("unexpected crates.io index lookup");
      },
      now: NOW,
    });
    expect(result).toEqual({ checked: 0, errors: [] });
  });
  test("only crates.io base packages exempt matching head packages", async () => {
    const commit = "50798ef8f962f41e2cba1539e85b8f41605a7e71";
    const registryPackage = cargoGitLock(
      "stella-x",
      "registry+https://github.com/rust-lang/crates.io-index",
    );
    const basePackages = [
      cargoGitLock(
        "stella-x",
        `git+https://github.com/stella/x?tag=v1.0.0#${commit}`,
      ),
      '[[package]]\nname = "stella-x"\nversion = "1.0.0"\n',
      registryPackage,
    ];
    const expectedChecks = [1, 1, 0];

    for (const [index, basePackage] of basePackages.entries()) {
      let indexLookups = 0;
      const result = await checkNewCargoReleaseAges({
        lockfiles: new Map([["Cargo.lock", registryPackage]]),
        baseLockfiles: new Map([["Cargo.lock", basePackage]]),
        baseQuarantine: "excludes = []",
        loadApi: async () => {
          throw new Error("unexpected crates.io API lookup");
        },
        loadIndex: async () => {
          indexLookups++;
          return JSON.stringify({
            vers: "1.0.0",
            pubtime: "2026-08-20T12:00:00.000Z",
          });
        },
        now: NOW,
      });
      expect(result).toEqual({ checked: expectedChecks[index], errors: [] });
      expect(indexLookups).toBe(expectedChecks[index]);
    }
  });
  test("warns for expired exceptions on push and schedule", () => {
    const input = {
      quarantine: quarantine(
        '"crate@1.0.0", # quarantine-expires: 2026-08-20T12:00:00.000Z',
      ),
      config: '[registry]\nglobal-min-publish-age = "5 days"',
      lockfiles: new Map([["Cargo.lock", cargoLock()]]),
      now: NOW,
    };
    for (const eventName of ["push", "schedule"]) {
      const result = checkCargoPolicy({ ...input, eventName });
      expect(result.errors).toEqual([]);
      expect(result.warnings.join("\n")).toContain("expired");
    }
  });
  test("rejects stale excludes and caps new expiry while warning on inherited expiry", () => {
    const input = {
      quarantine: quarantine(
        '"missing@1.0.0", # quarantine-expires: 2026-09-10T12:00:00.000Z',
      ),
      config: '[registry]\nglobal-min-publish-age = "5 days"',
      lockfiles: new Map([["Cargo.lock", cargoLock()]]),
      now: NOW,
    };
    expect(checkCargoPolicy(input).errors.join("\n")).toContain(
      "stale exclude",
    );
    expect(checkCargoPolicy(input).errors.join("\n")).toContain("more than");
    expect(
      checkCargoPolicy({
        ...input,
        eventName: "pull_request",
        baseQuarantine: input.quarantine,
      }).warnings.join("\n"),
    ).toContain("more than");
  });
  test("requires every exclusion shape to be an annotated double-quoted line", () => {
    const input = {
      config: '[registry]\nglobal-min-publish-age = "5 days"',
      lockfiles: new Map([["Cargo.lock", cargoLock()]]),
      now: NOW,
    };
    for (const value of [
      "excludes = ['crate@1.0.0']",
      'excludes = ["crate@1.0.0"]',
      "excludes = [42]",
    ]) {
      expect(
        checkCargoPolicy({ ...input, quarantine: value }).errors.join("\n"),
      ).toContain("must declare one annotated package per line");
    }
  });
  test("computes sparse index paths", () =>
    expect(["a", "ab", "abc", "serde"].map(cratesIndexPath)).toEqual([
      "1/a",
      "2/ab",
      "3/a/abc",
      "se/rd/serde",
    ]));
  test("uses pubtime, API fallback, fails closed, and enforces age", async () => {
    const lockfiles = new Map([["Cargo.lock", cargoLock()]]);
    const old = await checkNewCargoReleaseAges({
      lockfiles,
      now: NOW,
      loadIndex: async () =>
        '{"vers":"1.0.0","pubtime":"2026-08-20T12:00:00Z"}',
      loadApi: async () => {
        throw new Error("unused");
      },
    });
    expect(old.errors).toEqual([]);
    const young = await checkNewCargoReleaseAges({
      lockfiles,
      now: NOW,
      loadIndex: async () => '{"vers":"1.0.0"}',
      loadApi: async () => ({
        version: { created_at: "2026-08-28T12:00:00Z" },
      }),
    });
    expect(young.errors.join("\n")).toContain("younger than");
    const absent = await checkNewCargoReleaseAges({
      lockfiles,
      now: NOW,
      loadIndex: async () => '{"vers":"1.0.0"}',
      loadApi: async () => ({ version: {} }),
    });
    expect(absent.errors.join("\n")).toContain("no publication time");
    expect(
      (
        await checkNewCargoReleaseAges({
          lockfiles,
          excludes: ["crate@1.0.0"],
          now: NOW,
          loadIndex: async () => {
            throw new Error("unused");
          },
          loadApi: async () => ({}),
        })
      ).checked,
    ).toBe(0);
  });

  test("trusts Cargo bases only for change events with a valid policy", async () => {
    const lockfiles = new Map([["Cargo.lock", cargoLock()]]);
    const common = {
      baseLockfiles: lockfiles,
      baseQuarantine: "excludes = []\n",
      lockfiles,
      loadApi: async () => {
        throw new Error("unused");
      },
      loadIndex: async () =>
        '{"vers":"1.0.0","pubtime":"2026-08-20T12:00:00Z"}',
      now: NOW,
    };
    expect(await checkNewCargoReleaseAges(common)).toEqual({
      checked: 0,
      errors: [],
    });
    expect(
      await checkNewCargoReleaseAges({ ...common, eventName: "push" }),
    ).toEqual({ checked: 1, errors: [] });
    expect(
      await checkNewCargoReleaseAges({
        ...common,
        baseQuarantine: "not valid toml = [",
      }),
    ).toEqual({ checked: 1, errors: [] });
  });

  test("rechecks a Cargo version when its base exception is removed", async () => {
    const lockfiles = new Map([["Cargo.lock", cargoLock()]]);
    const result = await checkNewCargoReleaseAges({
      baseLockfiles: lockfiles,
      baseQuarantine: 'excludes = ["crate@1.0.0"]\n',
      excludes: [],
      lockfiles,
      loadApi: async () => {
        throw new Error("unused");
      },
      loadIndex: async () =>
        '{"vers":"1.0.0","pubtime":"2026-08-28T12:00:00Z"}',
      now: NOW,
    });
    expect(result.checked).toBe(1);
    expect(result.errors.join("\n")).toContain("younger than");
  });

  test("bounds Cargo index concurrency and fetches each crate index once", async () => {
    const packages = Array.from(
      { length: 12 },
      (_, index) => `[[package]]
name = "crate-${index}"
version = "1.0.0"
source = "sparse+https://index.crates.io/"
[[package]]
name = "crate-${index}"
version = "2.0.0"
source = "sparse+https://index.crates.io/"`,
    ).join("\n");
    let active = 0;
    let maximum = 0;
    const fetched: string[] = [];
    const result = await checkNewCargoReleaseAges({
      lockfiles: new Map([["Cargo.lock", packages]]),
      loadApi: async () => {
        throw new Error("unused");
      },
      loadIndex: async (name) => {
        fetched.push(name);
        active++;
        maximum = Math.max(maximum, active);
        await Bun.sleep(1);
        active--;
        return ["1.0.0", "2.0.0"]
          .map((version) =>
            JSON.stringify({
              pubtime: "2026-08-20T12:00:00Z",
              vers: version,
            }),
          )
          .join("\n");
      },
      now: NOW,
    });
    expect(result.errors).toEqual([]);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(fetched).toHaveLength(12);
    expect(new Set(fetched).size).toBe(12);
  });

  test("serializes concurrent Cargo API fallbacks one second apart", async () => {
    const packages = ["first", "second", "third"]
      .map(
        (name) => `[[package]]
name = "${name}"
version = "1.0.0"
source = "sparse+https://index.crates.io/"`,
      )
      .join("\n");
    let clock = 0;
    const starts: number[] = [];
    const result = await checkNewCargoReleaseAges({
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
      lockfiles: new Map([["Cargo.lock", packages]]),
      loadApi: async () => {
        starts.push(clock);
        return { version: { created_at: "2026-08-20T12:00:00Z" } };
      },
      loadIndex: async () => '{"vers":"1.0.0"}',
      now: NOW,
    });
    expect(result.errors).toEqual([]);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  test("skips blank Cargo index lines and names malformed index errors", async () => {
    const lockfiles = new Map([["Cargo.lock", cargoLock()]]);
    const blank = await checkNewCargoReleaseAges({
      lockfiles,
      loadApi: async () => {
        throw new Error("unused");
      },
      loadIndex: async () =>
        '\n{"vers":"1.0.0","pubtime":"2026-08-20T12:00:00Z"}\n\n',
      now: NOW,
    });
    expect(blank.errors).toEqual([]);
    const malformed = await checkNewCargoReleaseAges({
      lockfiles,
      loadApi: async () => {
        throw new Error("unused");
      },
      loadIndex: async () => "not json",
      now: NOW,
    });
    expect(malformed.errors.join("\n")).toContain(
      "crate: crates.io lookup failed: malformed crates.io index entry for crate",
    );
  });
});
