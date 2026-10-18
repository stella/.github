import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("./rust-napi-ci.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = Bun.YAML.parse(workflowSource) as {
  on: { workflow_call: { inputs: Record<string, { default?: unknown }> } };
  jobs: Record<string, { if?: string; name?: string; "runs-on"?: string; steps?: Array<Record<string, unknown>> }>;
};
const jobs = workflow.jobs;
const uses = (job: (typeof jobs)[string], action: string) =>
  job.steps?.some((step) => step.uses === action) ?? false;

describe("Rust NAPI CI scope", () => {
  test("defaults existing callers to the full suite", () => {
    expect(workflow.on.workflow_call.inputs.scope.default).toBe("full");
  });

  test("PR scope allocates exactly one Ubuntu job", () => {
    const prEligible = Object.entries(jobs).filter(([, job]) => job.if?.includes("inputs.scope == 'pr'"));
    expect(prEligible.map(([id]) => id)).toEqual(["pr"]);
    expect(jobs.pr.name).toBe("PR checks (ubuntu-latest)");
    expect(jobs.pr["runs-on"]).toBe("ubuntu-latest");
    expect(jobs.pr.if).toBe("inputs.scope == 'pr' && inputs.trusted == 'true'");
  });

  test("every full-suite job is explicitly scope-gated", () => {
    for (const [id, job] of Object.entries(jobs)) {
      if (id === "pr") continue;
      expect(job.if, `${id} must require inputs.scope == 'full'`).toContain("inputs.scope == 'full'");
    }
  });

  test("PR scope uses the shared checks and both runtime smokes", () => {
    for (const action of [
      "./.github/actions/napi-typecheck",
      "./.github/actions/napi-rust-checks",
      "./.github/actions/napi-build",
    ]) expect(uses(jobs.pr, action), `pr must use ${action}`).toBeTrue();
    expect(jobs.pr.steps?.some((step) => step.run === "bun run test:runtime:bun")).toBeTrue();
    expect(jobs.pr.steps?.some((step) => step.run === "node scripts/runtime-smoke.mjs")).toBeTrue();
  });

  test("full typecheck and build jobs use their shared actions", () => {
    expect(uses(jobs.typecheck, "./.github/actions/napi-typecheck")).toBeTrue();
    for (const id of ["build", "build-macos-arm64", "build-linux", "build-linux-arm64", "build-wasm"])
      expect(uses(jobs[id], "./.github/actions/napi-build"), `${id} must use napi-build`).toBeTrue();
    expect(uses(jobs["rust-checks"], "./.github/actions/napi-rust-checks")).toBeTrue();
  });

  test("typecheck implementation has one owner", () => {
    const typecheckAction = readFileSync(new URL("../actions/napi-typecheck/action.yml", import.meta.url), "utf8");
    for (const marker of ["typecheck-rejection-", "Select compiler parity", "check:typecheck-parity"]) {
      expect(typecheckAction).toContain(marker);
      expect(workflowSource).not.toContain(marker);
    }
  });
});
