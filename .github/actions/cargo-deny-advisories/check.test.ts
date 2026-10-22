import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { evaluate } from "./check";

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
  headLockfile: lockfile(["application", "1.0.0"], ["affected", "2.0.0"]),
  now: NOW,
};

describe("cargo-deny advisories gate", () => {
  test("fails a change event for an advisory on a new crate version", () => {
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: lockfile(["application", "1.0.0"]),
      changeEvent: true,
    });
    expect(result.errors.join("\n")).toContain("RUSTSEC-2026-0001");
  });

  test("warns for a pre-existing crate on a change event and fails on push", () => {
    const baseLockfile = common.headLockfile;
    const change = evaluate({ ...common, baseConfig: config(), baseLockfile, changeEvent: true });
    expect(change.errors).toEqual([]);
    expect(change.warnings.join("\n")).toContain("RUSTSEC-2026-0001");

    const push = evaluate({ ...common, changeEvent: false });
    expect(push.errors.join("\n")).toContain("RUSTSEC-2026-0001");
  });

  test("treats an affected crate version bump as new", () => {
    const result = evaluate({
      ...common,
      baseConfig: config(),
      baseLockfile: lockfile(["application", "1.0.0"], ["affected", "1.0.0"]),
      changeEvent: true,
    });
    expect(result.errors.join("\n")).toContain("affected@2.0.0");
  });

  test("fails closed when the base lockfile is unreadable", () => {
    const result = evaluate({ ...common, baseConfig: config(), changeEvent: true });
    expect(result.errors).toContain("base lockfile could not be read");
  });

  test("fails closed on a nonzero cargo-deny exit without diagnostics", () => {
    const result = evaluate({
      ...common,
      cargoDeny: { exitCode: 2, output: "database failed" },
      changeEvent: false,
    });
    expect(result.errors.join("\n")).toContain("without a parseable");
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
});
