import { describe, expect, test } from "bun:test";
import liveFixture from "./fixtures/live-ruleset.json";
import template from "./ruleset.json";
import settings from "./settings.json";
import { applyBaseline, audit, auditToolchain, checkInventory, diff, normalise, parseArgs, parseInventory, parseToolchain, parseToolchainExceptions, parseToolObservations, render, type Entry, type RepositoryApi, type RepositoryState, type Ruleset, type Toolchain, type ToolchainException, type ToolchainObservation } from "./apply";

const entry: Entry = { gate: "ci-result", extraChecks: ["dependency-review"], signatures: true, enabled: true };
const live = structuredClone(liveFixture) as Ruleset;
// The live fixture predates the explicit unattributed-change protection.
live.rules.find((rule) => rule.type === "pull_request")!.parameters!.require_extra_approval_for_unattributed_changes = true;
const inventory = { "fixture/project": entry };

describe("render", () => {
  test("each repository gets a deep copy independent of other renders and the template", () => {
    const originalTemplate = structuredClone(template);
    const firstEntry: Entry = { gate: "first-gate", extraChecks: ["first-extra"], signatures: true, enabled: true };
    const secondEntry: Entry = { gate: "second-gate", extraChecks: ["second-extra"], signatures: false, enabled: true };
    const first = render(firstEntry);
    const second = render(secondEntry);
    const originalSecond = structuredClone(second);
    const checks = first.rules.find((rule) => rule.type === "required_status_checks")!.parameters!.required_status_checks as { context: string }[];
    checks[0]!.context = "mutated-gate";
    checks.push({ context: "mutated-extra" });
    first.rules.find((rule) => rule.type === "merge_queue")!.parameters!.max_entries_to_build = 999;
    (first.conditions.ref_name as { include: string[] }).include.push("refs/heads/mutated");
    first.bypass_actors[0]!.actor_id = 999;
    first.rules.push({ type: "mutated-rule" });
    expect(second).toEqual(originalSecond);
    expect(template).toEqual(originalTemplate);
    expect(render(secondEntry)).toEqual(originalSecond);
    expect(render(firstEntry).rules.find((rule) => rule.type === "required_status_checks")!.parameters!.required_status_checks).toEqual([{ context: "first-gate" }, { context: "cla / cla" }, { context: "first-extra" }]);
  });
  test("pins the complete queue and review policy", () => {
    const body = render(entry);
    expect(body.name).toBe("main-branch-protection");
    expect(body.target).toBe("branch");
    expect(body.enforcement).toBe("active");
    expect(body.conditions).toEqual({ ref_name: { include: ["refs/heads/main"], exclude: [] } });
    expect(body.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
    expect(body.rules.find((rule) => rule.type === "merge_queue")?.parameters).toEqual({
      merge_method: "SQUASH", grouping_strategy: "HEADGREEN", min_entries_to_merge: 1,
      max_entries_to_merge: 10, max_entries_to_build: 6, min_entries_to_merge_wait_minutes: 5,
      check_response_timeout_minutes: 150,
    });
    expect(body.rules.find((rule) => rule.type === "pull_request")?.parameters).toEqual({
      required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false, require_last_push_approval: false,
      required_review_thread_resolution: true, require_extra_approval_for_unattributed_changes: true, allowed_merge_methods: ["squash"],
    });
    expect(body.rules.map((rule) => rule.type).sort()).toEqual([
      "deletion", "merge_queue", "non_fast_forward", "pull_request", "required_linear_history", "required_signatures", "required_status_checks",
    ]);
  });
  test("renders check names once and toggles signatures without mutating the template", () => {
    for (const signatures of [false, true]) {
      const body = render({ ...entry, signatures, gate: "checks", extraChecks: ["checks", "cla / cla", "extra", "extra"] });
      expect(body.rules.some((rule) => rule.type === "required_signatures")).toBe(signatures);
      expect(body.rules.find((rule) => rule.type === "required_status_checks")?.parameters).toEqual({
        strict_required_status_checks_policy: false, do_not_enforce_on_create: false,
        required_status_checks: [{ context: "checks" }, { context: "cla / cla" }, { context: "extra" }],
      });
    }
    expect(diff(live, render(entry))).toEqual([]);
  });
});

describe("normalise and diff", () => {
  test("unattributed-change protection is required and an off live setting drifts", () => {
    expect(render(entry).rules.find((rule) => rule.type === "pull_request")!.parameters!.require_extra_approval_for_unattributed_changes).toBe(true);
    expect(diff(liveFixture as Ruleset, render(entry)).map((change) => change.rule)).toEqual(["rules.pull_request"]);
  });
  test("the live response matches its rendered policy despite server metadata and defaults", () => {
    expect(diff(live, render(entry))).toEqual([]);
    expect(normalise(normalise(live))).toEqual(normalise(live));
    const normalized = normalise(live);
    for (const field of ["id", "source_type", "source", "node_id", "created_at", "updated_at", "current_user_can_bypass", "_links"]) {
      expect(live).toHaveProperty(field);
      expect(normalized).not.toHaveProperty(field);
    }
  });
  test("order, null app bindings and empty parameters carry no drift", () => {
    const reordered = structuredClone(live);
    reordered.rules.reverse();
    const checks = reordered.rules.find((rule) => rule.type === "required_status_checks")!.parameters!.required_status_checks as { context: string; integration_id?: null }[];
    checks.reverse();
    for (const check of checks) check.integration_id = null;
    reordered.rules.find((rule) => rule.type === "deletion")!.parameters = {};
    expect(diff(reordered, render(entry))).toEqual([]);
  });
  test("reports exactly one line per changed rule, including additions and removals", () => {
    const changed = structuredClone(live);
    changed.rules.find((rule) => rule.type === "merge_queue")!.parameters!.max_entries_to_build = 3;
    changed.rules.find((rule) => rule.type === "merge_queue")!.parameters!.merge_method = "MERGE";
    changed.rules = changed.rules.filter((rule) => rule.type !== "required_signatures");
    changed.rules.push({ type: "creation" });
    expect(diff(changed, render(entry)).map((change) => change.rule)).toEqual(["rules.creation", "rules.merge_queue", "rules.required_signatures"]);
  });
  test("preserves restrictive server fields and explicit app bindings", () => {
    const changed = structuredClone(live);
    changed.rules.find((rule) => rule.type === "pull_request")!.parameters!.dismissal_restriction = { enabled: true, allowed_actors: [] };
    const checks = changed.rules.find((rule) => rule.type === "required_status_checks")!.parameters!.required_status_checks as { context: string; integration_id?: number }[];
    checks[0]!.integration_id = 123;
    expect(diff(changed, render(entry)).map((change) => change.rule)).toEqual(["rules.pull_request", "rules.required_status_checks"]);
  });
  test("missing ruleset and changed enforcement are visible", () => {
    expect(diff(null, render(entry))[0]!.rule).toBe("ruleset");
    expect(diff({ ...live, enforcement: "disabled" }, render(entry))[0]!.rule).toBe("enforcement");
  });
});

describe("enumerating guard", () => {
  test("redacted bypass actors fail with insufficient permission instead of policy drift", () => {
    const redacted = structuredClone(live);
    Reflect.deleteProperty(redacted, "bypass_actors");
    const result = checkInventory(inventory, [{ repo: "fixture/project", rulesets: [redacted] }]);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toStartWith("fixture/project INSUFFICIENT_PERMISSION: bypass_actors unavailable;");
    expect(result.lines[0]).not.toContain(" -> ");
    expect(() => normalise(redacted)).toThrow("INSUFFICIENT_PERMISSION");
    expect(() => diff(redacted, render(entry))).toThrow("INSUFFICIENT_PERMISSION");
    const empty = structuredClone(live);
    empty.bypass_actors = [];
    expect(diff(empty, render(entry)).map((change) => change.rule)).toEqual(["bypass_actors"]);
  });
  test("one drifting and one unlisted repository both cause a failing report", () => {
    const changed = structuredClone(live);
    changed.rules.find((rule) => rule.type === "merge_queue")!.parameters!.max_entries_to_build = 2;
    const lines = audit(inventory, [
      { repo: "fixture/project", rulesets: [changed] },
      { repo: "fixture/unlisted", rulesets: [live] },
      { repo: "fixture/unmanaged", rulesets: [] },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("fixture/project rules.merge_queue:");
    expect(lines[1]).toStartWith("fixture/unlisted inventory:");
    expect(lines.length ? 1 : 0).toBe(1);
  });
  test("unlisted merge queue with a different ruleset name is caught", () => {
    expect(audit(inventory, [{ repo: "fixture/project", rulesets: [live] }, { repo: "fixture/other", rulesets: [{ ...live, name: "other" }] }])).toHaveLength(1);
  });
  test("case-insensitive identities, missing repos, duplicates and disabled entries are checked", () => {
    expect(audit(inventory, [{ repo: "FIXTURE/PROJECT", rulesets: [live] }])).toEqual([]);
    expect(audit(inventory, [])).toEqual(["fixture/project repository: missing from organization listing"]);
    expect(audit(inventory, [{ repo: "fixture/project", rulesets: [live, live] }])[0]).toContain("multiple");
    expect(audit({ "fixture/project": { ...entry, enabled: false } }, [{ repo: "fixture/project", rulesets: [] }])[0]).toContain("ruleset:");
  });
});

describe("input boundaries", () => {
  test("all CLI modes require inventory, while writes require explicit repositories and a backup directory", () => {
    expect(parseArgs(["--inventory", "repos.json", "--check"]).mode).toBe("check");
    expect(parseArgs(["--dry-run", "--inventory", "repos.json"]).mode).toBe("dry-run");
    expect(parseArgs(["--inventory", "repos.json", "--repo", "fixture/project", "--repo", "fixture/other", "--backup-dir", "backups"])).toEqual({ inventory: "repos.json", mode: "apply", repos: ["fixture/project", "fixture/other"], backupDir: "backups" });
    for (const args of [[], ["--check"], ["--inventory"], ["--inventory", "repos.json", "--check", "--dry-run"], ["--inventory", "repos.json"], ["--inventory", "repos.json", "--repo", "fixture/project"], ["--inventory", "repos.json", "--backup-dir", "backups"], ["--inventory", "repos.json", "apply", "fixture/project", "--backup-dir", "backups"], ["--inventory", "repos.json", "--check", "fixture/project"], ["--inventory", "repos.json", "--unknown"]]) {
      expect(() => parseArgs(args)).toThrow();
    }
  });
  test("inventory validates every option and rejects malformed or duplicate identities", () => {
    expect(parseInventory(inventory)).toEqual(inventory);
    for (const invalid of [null, [], {}, { "fixture/project": { ...entry, gate: "" } }, { "fixture/project": { ...entry, extraChecks: [""] } }, { "fixture/project": { ...entry, signatures: "true" } }, { "fixture/project": { ...entry, enabled: 1 } }, { "fixture/project": { ...entry, extra: true } }, { "../project": entry }, { "fixture/project": entry, "FIXTURE/PROJECT": entry }]) {
      expect(() => parseInventory(invalid)).toThrow();
    }
  });
});

describe("repository baseline", () => {
  const desiredLive = render(entry);
  desiredLive.id = 7;
  desiredLive.source_type = "Repository";
  desiredLive.source = "fixture/project";
  function fake(repository: RepositoryState, rulesets: Ruleset[] = [desiredLive]) {
    const calls: string[] = [];
    const api: RepositoryApi = {
      getRepository: () => repository,
      getRulesets: () => rulesets,
      backup: (_repo, kind) => { calls.push(`backup:${kind}`); },
      patchRepository: (_repo, body) => { calls.push(`patch:${JSON.stringify(body)}`); },
      upsertRuleset: () => { calls.push("ruleset"); },
    };
    return { api, calls };
  }

  test("detects settings drift in dry-run and patches it when applying", () => {
    const repository = { archived: false, ...settings, allow_auto_merge: false };
    const dry = fake(repository);
    const report = applyBaseline(inventory, dry.api, true);
    expect(report.exitCode).toBe(1);
    expect(report.lines.some((line) => line.startsWith("fixture/project settings.allow_auto_merge:"))).toBe(true);
    expect(dry.calls).toEqual([]);
    const apply = fake(repository);
    expect(applyBaseline(inventory, apply.api, false).exitCode).toBe(0);
    expect(apply.calls).toEqual(["backup:settings", `patch:${JSON.stringify(settings)}`]);
  });

  test("refuses inherited rulesets before settings drift can cause a write", () => {
    const inherited = structuredClone(desiredLive);
    inherited.source_type = "Organization";
    inherited.source = "fixture";
    inherited.rules.find((rule) => rule.type === "merge_queue")!.parameters!.max_entries_to_build = 2;
    const { api, calls } = fake({ archived: false, ...settings, allow_auto_merge: false }, [inherited]);
    expect(() => applyBaseline(inventory, api, false)).toThrow("Refusing to update inherited ruleset: fixture/project");
    expect(calls).toEqual([]);
  });

  test("backs up settings and rulesets immediately before their writes", () => {
    const changed = structuredClone(desiredLive);
    changed.rules.find((rule) => rule.type === "merge_queue")!.parameters!.max_entries_to_build = 2;
    const { api, calls } = fake({ archived: false, ...settings, allow_auto_merge: false }, [changed]);
    expect(applyBaseline(inventory, api, false).exitCode).toBe(0);
    expect(calls).toEqual(["backup:settings", `patch:${JSON.stringify(settings)}`, "backup:ruleset", "ruleset"]);
  });

  test("missing-gate repositories are refused before backup or write", () => {
    const missing = { ...entry, missingGate: true };
    const { api, calls } = fake({ archived: false, ...settings, allow_auto_merge: false }, [render(missing)]);
    expect(applyBaseline({ "fixture/project": missing }, api, false).lines[0]).toBe("fixture/project: missing gate");
    expect(calls).toEqual([]);
  });

  test("a clean repository is a no-op with a successful dry-run", () => {
    const { api, calls } = fake({ archived: false, ...settings });
    expect(applyBaseline(inventory, api, true)).toEqual({ lines: ["fixture/project: no drift"], exitCode: 0 });
    expect(calls).toEqual([]);
  });

  test("archived repositories are reported and skipped", () => {
    const { api, calls } = fake({ archived: true, ...settings });
    expect(applyBaseline(inventory, api, true)).toEqual({ lines: ["fixture/project: archived; skipped"], exitCode: 0 });
    expect(calls).toEqual([]);
  });

  test("CLA defaults to its real check name and missing-gate entries omit queue requirements", () => {
    const withoutOverrides: Entry = { extraChecks: [], signatures: false, enabled: true };
    const checks = render(withoutOverrides).rules.find((rule) => rule.type === "required_status_checks")!.parameters!.required_status_checks;
    expect(checks).toEqual([{ context: "ci-result" }, { context: "cla / cla" }]);
    const missing = { ...withoutOverrides, missingGate: true };
    const { api } = fake({ archived: false, ...settings }, [render(missing)]);
    const report = applyBaseline({ "fixture/project": missing }, api, true);
    expect(report).toEqual({ lines: ["fixture/project: missing gate", "fixture/project: no drift"], exitCode: 0 });
    expect(render(missing).rules.some((rule) => rule.type === "merge_queue")).toBe(false);
    expect(render(missing).rules.find((rule) => rule.type === "required_status_checks")!.parameters!.required_status_checks).toEqual([{ context: "cla / cla" }]);
  });
});

const toolchain: Toolchain = { bun: "1.4.3", node: "26.10.0", rust: "1.99.0" };
const migration = (expires: string): ToolchainException[] => [{ repo: "fixture/project", tool: "bun", pin: "1.4.2", reason: "Scheduled migration", expires }];
const observed = (tool: "bun" | "node" | "rust", pin: string): ToolchainObservation => ({
  repo: "fixture/project",
  tools: {
    bun: { status: "not-pinned" }, node: { status: "not-pinned" }, rust: { status: "not-pinned" },
    [tool]: { status: "pinned", pin },
  },
});

describe("toolchain standard", () => {
  test("matching full versions pass", () => {
    expect(auditToolchain(toolchain, [], [observed("bun", "1.4.3")], "2026-10-18").failures).toEqual([]);
  });
  test("a patch mismatch fails and reports both exact versions", () => {
    expect(auditToolchain(toolchain, [], [observed("bun", "1.4.2")], "2026-10-18").failures).toEqual(["fixture/project: bun pinned 1.4.2, standard 1.4.3"]);
  });
  test("missing files are typed not-pinned summaries, not failures", () => {
    const observation = parseToolObservations("fixture/project", { bun: null, node: null, rust: null });
    expect(observation.tools).toEqual({ bun: { status: "not-pinned" }, node: { status: "not-pinned" }, rust: { status: "not-pinned" } });
    expect(auditToolchain(toolchain, [], [observation], "2026-10-18")).toEqual({
      lines: ["fixture/project: bun not pinned", "fixture/project: node not pinned", "fixture/project: rust not pinned"], failures: [],
    });
  });
  test("an unexpired exact exception permits its pin", () => {
    expect(auditToolchain(toolchain, migration("2026-10-19"), [observed("bun", "1.4.2")], "2026-10-18").failures).toEqual([]);
  });
  test("an exception only covers its exact pin", () => {
    expect(auditToolchain(toolchain, migration("2026-10-19"), [observed("bun", "1.4.1")], "2026-10-18").failures).toEqual(["fixture/project: bun pinned 1.4.1, standard 1.4.3"]);
  });
  test("an expired exception fails with its reason", () => {
    expect(auditToolchain(toolchain, migration("2026-10-17"), [observed("bun", "1.4.2")], "2026-10-18").failures[0]).toContain("exception expired 2026-10-17: Scheduled migration");
  });
  test("present malformed pins fail rather than being skipped", () => {
    const observation = parseToolObservations("fixture/project", {
      bun: JSON.stringify({ packageManager: "npm@11.0.0" }), node: "26", rust: "[toolchain]\nchannel = \"stable\"\n",
    });
    const result = auditToolchain(toolchain, [], [observation], "2026-10-18");
    expect(result.failures).toHaveLength(3);
    expect(result.failures.every((line) => line.includes("unsupported format"))).toBe(true);
  });
  test("the standard rejects unknown keys, exceptions and malformed versions with a named error", () => {
    expect(parseToolchain(toolchain)).toEqual(toolchain);
    for (const invalid of [{ ...toolchain, extra: true }, { ...toolchain, bun: "1.4" }, { ...toolchain, exceptions: [] }]) {
      try { parseToolchain(invalid); expect.unreachable(); }
      catch (error) { expect(error).toHaveProperty("name", "ToolchainParseError"); }
    }
  });
  test("exceptions reject unknown keys, blank reasons and impossible ISO dates with a named error", () => {
    expect(parseToolchainExceptions(migration("2026-10-19"))).toEqual(migration("2026-10-19"));
    for (const invalid of [{}, [{ ...migration("2026-10-19")[0], extra: true }], [{ ...migration("2026-10-19")[0], reason: " " }], migration("2026-02-30")]) {
      try { parseToolchainExceptions(invalid); expect.unreachable(); }
      catch (error) { expect(error).toHaveProperty("name", "ToolchainParseError"); }
    }
  });
  test("rust pins are read as TOML, so comments and spacing do not matter", () => {
    const observation = parseToolObservations("fixture/project", {
      bun: null, node: null, rust: "[toolchain] # pinned for the workspace\nchannel = \"1.99.0\" # stable\n",
    });
    expect(observation.tools.rust).toEqual({ status: "pinned", pin: "1.99.0" });
  });
  test("malformed manifests are described without echoing their contents", () => {
    const secret = "private-dependency-name";
    const observation = parseToolObservations("fixture/project", {
      bun: `{"packageManager": "npm@11.0.0", "dependencies": {"${secret}": "1.0.0"}`, node: null, rust: `[tool\nchannel = "${secret}"`,
    });
    const result = auditToolchain(toolchain, [], [observation], "2026-10-18");
    expect(result.failures).toHaveLength(2);
    expect(result.failures.join("\n")).not.toContain(secret);
  });
  test("duplicate exceptions for one repository, tool and pin are rejected", () => {
    const [entry] = migration("2026-10-19");
    try { parseToolchainExceptions([entry, { ...entry, repo: "FIXTURE/project", expires: "2026-10-30" }]); expect.unreachable(); }
    catch (error) { expect(error).toHaveProperty("name", "ToolchainParseError"); }
  });
  test("toolchain exceptions are accepted only with --check", () => {
    expect(parseArgs(["--inventory", "repos.json", "--check", "--toolchain-exceptions", "exceptions.json"]).toolchainExceptions).toBe("exceptions.json");
    expect(() => parseArgs(["--inventory", "repos.json", "--dry-run", "--toolchain-exceptions", "exceptions.json"])).toThrow();
  });
});
