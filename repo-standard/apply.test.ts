import { describe, expect, test } from "bun:test";
import liveFixture from "./fixtures/live-ruleset.json";
import { audit, diff, normalise, parseArgs, parseInventory, render, type Entry, type Ruleset } from "./apply";

const entry: Entry = { gate: "ci-result", extraChecks: ["dependency-review"], signatures: true, enabled: true };
const live = structuredClone(liveFixture) as Ruleset;
// The live fixture predates the explicit unattributed-change protection.
live.rules.find((rule) => rule.type === "pull_request")!.parameters!.require_extra_approval_for_unattributed_changes = true;
const inventory = { "fixture/project": entry };

describe("render", () => {
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
      const body = render({ ...entry, signatures, gate: "checks", extraChecks: ["checks", "cla", "extra", "extra"] });
      expect(body.rules.some((rule) => rule.type === "required_signatures")).toBe(signatures);
      expect(body.rules.find((rule) => rule.type === "required_status_checks")?.parameters).toEqual({
        strict_required_status_checks_policy: false, do_not_enforce_on_create: false,
        required_status_checks: [{ context: "checks" }, { context: "cla" }, { context: "extra" }],
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
    expect(normalise(live)).not.toHaveProperty("source");
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
  test("all CLI modes require inventory, apply also requires explicit targets and backup directory", () => {
    expect(parseArgs(["--inventory", "repos.json", "--check"]).mode).toBe("check");
    expect(parseArgs(["--dry-run", "--inventory", "repos.json"]).mode).toBe("dry-run");
    expect(parseArgs(["apply", "fixture/project", "--inventory", "repos.json", "--backup-dir", "backups"])).toEqual({ inventory: "repos.json", mode: "apply", repos: ["fixture/project"], backupDir: "backups" });
    for (const args of [[], ["--check"], ["--inventory"], ["--inventory", "repos.json", "--check", "--dry-run"], ["--inventory", "repos.json", "apply", "fixture/project"], ["--inventory", "repos.json", "--check", "fixture/project"], ["--inventory", "repos.json", "--unknown"]]) {
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
