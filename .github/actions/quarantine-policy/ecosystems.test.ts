import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkBunTrustedDependencies, checkCargoPolicy, checkPnpmPolicy, checkRepositoryPolicy, pruneRepositoryExcludes, readCargoPackages, readPnpmLockedRegistryVersions } from "./ecosystems";
import { checkNewCargoReleaseAges, cratesIndexPath } from "./check-lock-age";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const pnpmLock = `lockfileVersion: '9.0'\npackages:\n  foo@1.2.3(peer@2.0.0): {}\n  '@scope/bar@2.0.0': {}\n`;
const workspace = `minimumReleaseAge: 7200\nminimumReleaseAgeExclude:\n  - "hotfix@1.0.0" # quarantine-expires: 2026-08-30T12:00:00.000Z\nonlyBuiltDependencies:\n  - foo\n`;
const cargoLock = (source = 'registry+https://github.com/rust-lang/crates.io-index') => `version = 3\n[[package]]\nname = "crate"\nversion = "1.0.0"\nsource = "${source}"\n[[package]]\nname = "local"\nversion = "0.1.0"\n`;
const quarantine = (entry = '"crate@1.0.0", # quarantine-expires: 2026-08-30T12:00:00.000Z') => `excludes = [\n  ${entry}\n]\n`;

test("Bun requires explicit, current trusted dependencies", () => {
  const lock = '{"packages":{"foo":["foo@1.0.0",""]}}';
  expect(checkBunTrustedDependencies("{}", lock).join("\n")).toContain("must declare");
  expect(checkBunTrustedDependencies('{"trustedDependencies":["missing"]}', lock).join("\n")).toContain("missing package");
  expect(checkBunTrustedDependencies('{"trustedDependencies":["foo"]}', lock)).toEqual([]);
});

test("detects unsupported locks and unlocked manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-detect-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "package.json"), "{}");
    spawnSync("git", ["add", "package.json"], { cwd: root });
    expect(checkRepositoryPolicy({ root, eventName: "push", now: NOW }).errors.join("\n")).toContain("unlocked");
    writeFileSync(join(root, "yarn.lock"), "");
    spawnSync("git", ["add", "yarn.lock"], { cwd: root });
    expect(checkRepositoryPolicy({ root, eventName: "push", now: NOW }).errors.join("\n")).toContain("unsupported lockfiles");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prunes expired entries from all ecosystem files", () => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-prune-"));
  try {
    mkdirSync(join(root, ".cargo"));
    const marker = '"old@1.0.0", # quarantine-expires: 2026-08-20T00:00:00.000Z';
    writeFileSync(join(root, "bunfig.toml"), `[install]\nminimumReleaseAgeExcludes = [\n  ${marker}\n]`);
    writeFileSync(join(root, "pnpm-workspace.yaml"), `minimumReleaseAgeExclude:\n  - ${marker}\n`);
    writeFileSync(join(root, ".cargo/quarantine.toml"), `excludes = [\n  ${marker}\n]`);
    expect(pruneRepositoryExcludes({ root, now: NOW })).toBe(3);
    for (const file of ["bunfig.toml", "pnpm-workspace.yaml", ".cargo/quarantine.toml"]) expect(readFileSync(join(root, file), "utf8")).not.toContain("old@1.0.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("pnpm quarantine", () => {
  test("parses v9 keys and strips peer suffixes", () => expect(readPnpmLockedRegistryVersions(pnpmLock)).toEqual([
    { name: "@scope/bar", version: "2.0.0" }, { name: "foo", version: "1.2.3" },
  ]));
  test("accepts valid policy and rejects unsafe build configuration", () => {
    const input = { workspace, lockfile: pnpmLock, packageJson: '{"packageManager":"pnpm@10.16.0"}', now: NOW };
    expect(checkPnpmPolicy(input).errors).toEqual([]);
    expect(checkPnpmPolicy({ ...input, workspace: workspace + "dangerouslyAllowAllBuilds: true\n" }).errors.join("\n")).toContain("dangerouslyAllowAllBuilds");
    expect(checkPnpmPolicy({ ...input, packageJson: '{"packageManager":"pnpm@10.15.0"}' }).errors.join("\n")).toContain("10.16.0");
  });
});

describe("Cargo quarantine", () => {
  test("allows crates.io and path members but rejects git and alternate registries", () => {
    const input = { quarantine: quarantine(), config: '[registry]\nglobal-min-publish-age = "5 days"', lockfiles: new Map([["Cargo.lock", cargoLock()]]), now: NOW };
    expect(checkCargoPolicy(input).errors).toEqual([]);
    for (const source of ["git+https://example.com/repo", "registry+https://example.com/index"]) {
      expect(checkCargoPolicy({ ...input, quarantine: "excludes = []", lockfiles: new Map([["Cargo.lock", cargoLock(source)]]) }).errors.join("\n")).toContain("unsupported source");
    }
    expect(readCargoPackages(cargoLock()).find((p) => p.name === "local")?.source).toBeUndefined();
  });
  test("rejects stale excludes and caps new expiry while warning on inherited expiry", () => {
    const input = { quarantine: quarantine('"missing@1.0.0", # quarantine-expires: 2026-09-10T12:00:00.000Z'), config: '[registry]\nglobal-min-publish-age = "5 days"', lockfiles: new Map([["Cargo.lock", cargoLock()]]), now: NOW };
    expect(checkCargoPolicy(input).errors.join("\n")).toContain("stale exclude");
    expect(checkCargoPolicy(input).errors.join("\n")).toContain("more than");
    expect(checkCargoPolicy({ ...input, eventName: "pull_request", baseQuarantine: input.quarantine }).warnings.join("\n")).toContain("more than");
  });
  test("computes sparse index paths", () => expect(["a", "ab", "abc", "serde"].map(cratesIndexPath)).toEqual(["1/a", "2/ab", "3/a/abc", "se/rd/serde"]));
  test("uses pubtime, API fallback, fails closed, and enforces age", async () => {
    const lockfiles = new Map([["Cargo.lock", cargoLock()]]);
    const old = await checkNewCargoReleaseAges({ lockfiles, now: NOW, loadIndex: async () => '{"vers":"1.0.0","pubtime":"2026-08-20T12:00:00Z"}', loadApi: async () => { throw new Error("unused"); } });
    expect(old.errors).toEqual([]);
    const young = await checkNewCargoReleaseAges({ lockfiles, now: NOW, loadIndex: async () => '{"vers":"1.0.0"}', loadApi: async () => ({ version: { created_at: "2026-08-28T12:00:00Z" } }) });
    expect(young.errors.join("\n")).toContain("younger than");
    const absent = await checkNewCargoReleaseAges({ lockfiles, now: NOW, loadIndex: async () => '{"vers":"1.0.0"}', loadApi: async () => ({ version: {} }) });
    expect(absent.errors.join("\n")).toContain("no publication time");
    expect((await checkNewCargoReleaseAges({ lockfiles, excludes: ["crate@1.0.0"], now: NOW, loadIndex: async () => { throw new Error("unused"); }, loadApi: async () => ({}) })).checked).toBe(0);
  });
});
