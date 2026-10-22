import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { baseInputs, cargoDenyArgs, evaluate } from "./check";

const diagnostic = readFileSync(
  ".github/actions/cargo-deny-advisories/fixtures/advisory.jsonl",
  "utf8",
);
const lockfile = (...packages: Array<[string, string]>): string =>
  packages
    .map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`)
    .join("\n");
const config = (ignore = ""): string => `[advisories]\nignore = [${ignore}]\n`;
const NOW = new Date("2026-10-22T12:00:00Z");
const common = {
  cargoDeny: { exitCode: 1, output: diagnostic },
  config: config(),
  headLockfile: lockfile(["application", "1.0.0"], ["unsafe-libyaml", "0.2.11"]),
  now: NOW,
};

describe("cargo-deny advisories gate", () => {
  test("places every global option before the advisories check", () => {
    expect(cargoDenyArgs()).toEqual([
      "cargo",
      "deny",
      "--manifest-path",
      "Cargo.toml",
      "--config",
      "deny.toml",
      "--format",
      "json",
      "check",
      "advisories",
    ]);
    const custom = cargoDenyArgs("workspace/Cargo.toml", "policy/deny.toml");
    expect(custom).toEqual([
      "cargo",
      "deny",
      "--manifest-path",
      "workspace/Cargo.toml",
      "--config",
      "policy/deny.toml",
      "--format",
      "json",
      "check",
      "advisories",
    ]);
    expect(custom.slice(custom.indexOf("check") + 1)).toEqual(["advisories"]);
  });

  test("reads base files from the checked-out directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "cargo-deny-base-"));
    const lockfilePath = "nested/Cargo.lock";
    const configPath = "policy/deny.toml";
    mkdirSync(dirname(join(directory, lockfilePath)), { recursive: true });
    mkdirSync(dirname(join(directory, configPath)), { recursive: true });
    writeFileSync(join(directory, lockfilePath), "base lockfile");
    writeFileSync(join(directory, configPath), "base config");

    expect(baseInputs("a".repeat(40), directory, lockfilePath, configPath)).toEqual({
      baseConfig: "base config",
      baseLockfile: "base lockfile",
    });
  });

  test("fails closed when the checked-out base lockfile is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "cargo-deny-base-"));
    const base = baseInputs("a".repeat(40), directory, "Cargo.lock", "deny.toml");
    const result = evaluate({ ...common, ...base, changeEvent: true });
    expect(result.errors).toContain("base lockfile could not be read");
  });

  test("rejects an invalid base SHA before reading base files", () => {
    expect(() => baseInputs("ABC123", "/does/not/exist", "Cargo.lock", "deny.toml")).toThrow(
      "base-sha must be 40 lowercase hex characters",
    );
  });

  test("configures the trusted base checkout like quarantine policy", () => {
    const action = Bun.YAML.parse(
      readFileSync(".github/actions/cargo-deny-advisories/action.yml", "utf8"),
    );
    const workflow = Bun.YAML.parse(
      readFileSync(".github/workflows/quarantine-policy.yml", "utf8"),
    );
    const checkout = action.runs.steps.find(
      (step: { name?: string }) => step.name === "Checkout trusted target base",
    );
    const quarantineCheckout = workflow.jobs.enforce.steps.find(
      (step: { name?: string }) => step.name === "Checkout trusted target base",
    );
    expect(checkout.uses).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(checkout.if).toBe("inputs.base-sha != ''");
    expect(checkout.with.ref).toBe("${{ inputs.base-sha }}");
    expect(checkout.with.path).toBe(".cargo-deny-base");
    expect(checkout.with["sparse-checkout"]).toBe(
      "${{ inputs.lockfile }}\n${{ inputs.config }}\n",
    );

    const omitted = new Set(["ref", "path", "sparse-checkout"]);
    const unchanged = (withInputs: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(withInputs).filter(([key]) => !omitted.has(key)));
    expect(unchanged(checkout.with)).toEqual(unchanged(quarantineCheckout.with));
  });

  test("fails a change event for an advisory on a new crate version", () => {
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: lockfile(["application", "1.0.0"]),
      changeEvent: true,
    });
    expect(result.errors.join("\n")).toContain("RUSTSEC-2024-0449");
  });

  test("warns for a pre-existing crate on a change event and fails on push", () => {
    const baseLockfile = common.headLockfile;
    const change = evaluate({ ...common, baseConfig: config(), baseLockfile, changeEvent: true });
    expect(change.errors).toEqual([]);
    expect(change.warnings.join("\n")).toContain("RUSTSEC-2024-0449");

    const push = evaluate({ ...common, changeEvent: false });
    expect(push.errors.join("\n")).toContain("RUSTSEC-2024-0449");
  });

  test("treats an affected crate version bump as new", () => {
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: lockfile(["application", "1.0.0"], ["unsafe-libyaml", "0.2.10"]),
      changeEvent: true,
    });
    expect(result.errors.join("\n")).toContain("unsafe-libyaml@0.2.11");
  });

  test("fails a change event when any advisory cannot be attributed", () => {
    const output = [
      JSON.stringify({
        type: "diagnostic",
        fields: {
          severity: "error",
          advisory: { id: "RUSTSEC-2026-0001", title: "Attributed" },
          graphs: [{ Krate: { name: "affected", version: "2.0.0" }, parents: [] }],
        },
      }),
      JSON.stringify({
        type: "diagnostic",
        fields: {
          severity: "error",
          advisory: { id: "RUSTSEC-2026-0002", title: "Unattributed" },
          graphs: [],
        },
      }),
    ].join("\n");
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: common.headLockfile,
      cargoDeny: { exitCode: 1, output },
      changeEvent: true,
    });
    expect(result.warnings.join("\n")).toContain("RUSTSEC-2026-0001 affects affected@2.0.0");
    expect(result.errors).toContain(
      "RUSTSEC-2026-0002: cannot attribute advisory to a locked crate",
    );
  });

  test("fails a change event when an advisory is accompanied by another error", () => {
    const output = [
      diagnostic,
      JSON.stringify({
        type: "diagnostic",
        fields: {
          severity: "error",
          code: "advisory-db-fetch",
          message: "failed to fetch the advisory database",
        },
      }),
    ].join("\n");
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: common.headLockfile,
      cargoDeny: { exitCode: 1, output },
      changeEvent: true,
    });
    expect(result.warnings.join("\n")).toContain("RUSTSEC-2024-0449");
    expect(result.errors).toContain(
      "advisory-db-fetch: failed to fetch the advisory database",
    );
  });

  test("ignores warning diagnostics without an advisory", () => {
    const output = [
      diagnostic,
      JSON.stringify({
        type: "diagnostic",
        fields: {
          severity: "warning",
          code: "advisory-db-stale",
          message: "the advisory database is stale",
        },
      }),
    ].join("\n");
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: common.headLockfile,
      cargoDeny: { exitCode: 1, output },
      changeEvent: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toContain("RUSTSEC-2024-0449");
    expect(result.warnings.join("\n")).not.toContain("advisory-db-stale");
  });

  test("fails for the new version when one diagnostic affects two versions", () => {
    const output = JSON.stringify({
      type: "diagnostic",
      fields: {
        severity: "error",
        advisory: { id: "RUSTSEC-2026-0003", title: "Multiple versions" },
        graphs: [
          { Krate: { name: "affected", version: "1.0.0" }, parents: [] },
          { krate: { name: "affected", version: "2.0.0" }, parents: [] },
        ],
      },
    });
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: lockfile(["application", "1.0.0"], ["affected", "1.0.0"]),
      cargoDeny: { exitCode: 1, output },
      changeEvent: true,
      headLockfile: lockfile(
        ["application", "1.0.0"],
        ["affected", "1.0.0"],
        ["affected", "2.0.0"],
      ),
    });
    expect(result.errors).toEqual([
      "RUSTSEC-2026-0003 affects affected@2.0.0: Multiple versions",
    ]);
    expect(result.warnings).toEqual([
      "RUSTSEC-2026-0003 affects affected@1.0.0: Multiple versions",
    ]);
  });

  test("fails closed when the base lockfile is unreadable", () => {
    const result = evaluate({ ...common, baseConfig: config(), changeEvent: true });
    expect(result.errors).toContain("base lockfile could not be read");
  });

  test("fails closed on a nonzero cargo-deny exit without diagnostics", () => {
    const stderr = "error: unexpected argument '--config' found";
    const result = evaluate({
      ...common,
      cargoDeny: { exitCode: 2, output: stderr, stderr },
      changeEvent: false,
    });
    expect(result.errors.join("\n")).toContain("code 2");
    expect(result.errors.join("\n")).toContain(stderr);
  });

  test("fails an ignore entry without an owner", () => {
    const result = evaluate({
      ...common,
      cargoDeny: { exitCode: 0, output: "" },
      changeEvent: false,
      config: config('{ id = "RUSTSEC-1", reason = "expires: 2027-01-01" }'),
    });
    expect(result.errors.join("\n")).toContain("missing owner");
  });

  test("warns for an unchanged expired ignore on a change and fails it on push", () => {
    const expired = config(
      '{ id = "RUSTSEC-1", reason = "owner: security expires: 2026-10-01" }',
    );
    const input = {
      ...common,
      cargoDeny: { exitCode: 0, output: "" },
      config: expired,
    };
    const change = evaluate({
      ...input,
      baseConfig: expired,
      baseLockfile: common.headLockfile,
      changeEvent: true,
    });
    expect(change.errors).toEqual([]);
    expect(change.warnings.join("\n")).toContain("expired");

    const push = evaluate({ ...input, changeEvent: false });
    expect(push.errors.join("\n")).toContain("expired");
  });

  test("accepts semicolon-separated waiver metadata", () => {
    const result = evaluate({
      ...common,
      cargoDeny: { exitCode: 0, output: "" },
      changeEvent: false,
      config: config(
        '{ id = "RUSTSEC-1", reason = "owner: supply-chain; expires: 2026-11-01; no fix released" }',
      ),
    });
    expect(result.errors).toEqual([]);
  });
});
