import assert from "node:assert/strict";
import test from "node:test";

import { publishReleaseEntries, validatePublishPlan } from "./runtime.mjs";
import { waitForNpmPackages } from "../npm-visibility/wait.mjs";

const entry = (name, dependencies = []) => ({
  name: `@stll/${name}`,
  version: "1.2.3",
  path: `${name}.tgz`,
  dependencies: dependencies.map((name) => `@stll/${name}`),
});
const planEnv = (plan, extra = {}) => ({
  PUBLISH_PLAN: JSON.stringify(plan),
  TARBALLS: plan.map(({ path }) => path).join("\n"),
  DIST_TAG: "next",
  ...extra,
});
const validationInput = (plan, extra = {}) => ({
  planText: JSON.stringify(plan),
  tarballs: plan.map(({ path }) => path).join("\n"),
  ...extra,
});
const noop = () => {};

for (const env of [
  { TARBALL: "one.tgz", EXPECTED_NAME: "@stll/one", EXPECTED_VERSION: "1.2.3", DIST_TAG: "next" },
  { TARBALLS: "one.tgz\ntwo.tgz", DIST_TAG: "latest", PUBLISH_PLAN: "" },
]) {
  test(`publication without a plan preserves the existing ${env.TARBALL ? "singular" : "multiple"} tarball contract`, async () => {
    const writes = [];
    await publishReleaseEntries({
      env,
      publishTarball: (received) => writes.push(received),
      waitForPackages: () => assert.fail("unplanned publication uses the original publisher's wait"),
    });
    assert.deepEqual(writes, [env]);
  });
}

test("checks all paths before publishing the first entry", async () => {
  const writes = [];
  await assert.rejects(publishReleaseEntries({
    env: planEnv([entry("a"), entry("b", ["a"])]),
    checkTarball: (path) => { if (path === "b.tgz") throw new Error("tarball missing"); },
    publishTarball: (received) => writes.push(received),
    writeOutput: noop,
  }), /tarball missing/);
  assert.deepEqual(writes, []);
});

test("publishes ordered entries through the hardened script with singular expected identities", async () => {
  const plan = [entry("core"), entry("ui", ["core"])];
  const env = planEnv(plan, { NODE_AUTH_TOKEN: "XXXXX-XXXXX-XXXXX-XXXXX", NPM_VISIBILITY_TIMEOUT_MINUTES: "7" });
  const calls = [];
  const readRegistryState = () => ({ exists: true });
  await publishReleaseEntries({
    env,
    now: () => 0,
    checkTarball: (path) => calls.push(["check", path]),
    publishTarball: (received) => {
      calls.push(["publish", received.EXPECTED_NAME]);
      const planned = plan.find(({ name }) => name === received.EXPECTED_NAME);
      assert.deepEqual(received, {
        ...env, TARBALL: planned.path, TARBALLS: "", EXPECTED_NAME: planned.name, EXPECTED_VERSION: planned.version,
      });
    },
    readRegistryState,
    waitForPackages: async ({ packages, timeoutMinutes, readNpmState }) => {
      calls.push(["visible", packages[0].name]);
      assert.equal(timeoutMinutes, 7);
      assert.equal(readNpmState, readRegistryState);
      return [];
    },
    writeOutput: noop,
  });
  assert.deepEqual(calls, [
    ["check", "core.tgz"], ["check", "ui.tgz"],
    ["publish", "@stll/core"], ["visible", "@stll/core"],
    ["publish", "@stll/ui"], ["visible", "@stll/ui"],
  ]);
});

test("uses the existing visibility backoff before allowing a dependent publish", async () => {
  let visible = false;
  const events = [];
  await publishReleaseEntries({
    env: planEnv([entry("core"), entry("ui", ["core"])]),
    checkTarball: noop,
    publishTarball: ({ EXPECTED_NAME }) => {
      if (EXPECTED_NAME === "@stll/ui") assert.equal(visible, true);
      events.push(`publish ${EXPECTED_NAME}`);
    },
    readRegistryState: (name) => ({ exists: name === "@stll/ui" || visible }),
    waitForPackages: (options) => waitForNpmPackages({
      ...options,
      recheckDelays: [1],
      wait: () => { visible = true; events.push("core visible"); },
    }),
    writeOutput: noop,
  });
  assert.deepEqual(events, ["publish @stll/core", "core visible", "publish @stll/ui"]);
});

test("publish failure reports transitive dependents and stops before unrelated remaining entries", async () => {
  const publishes = [];
  const outputs = [];
  await assert.rejects(publishReleaseEntries({
    env: planEnv([entry("core"), entry("ui", ["core"]), entry("app", ["ui"]), entry("unrelated")]),
    checkTarball: noop,
    publishTarball: ({ EXPECTED_NAME }) => { publishes.push(EXPECTED_NAME); throw new Error("publish failed"); },
    waitForPackages: () => assert.fail("failed publishes must not start a visibility wait"),
    writeOutput: (name, values) => outputs.push([name, values]),
  }), /Failed to publish @stll\/core@1.2.3: publish failed.*Skipped dependents: @stll\/ui, @stll\/app/);
  assert.deepEqual(publishes, ["@stll/core"]);
  assert.deepEqual(outputs, [
    ["skipped-dependents", []],
    ["skipped-dependents", ["@stll/ui", "@stll/app"]],
  ]);
});

test("visibility timeout blocks transitive dependents and reports them", async () => {
  const publishes = [];
  await assert.rejects(publishReleaseEntries({
    env: planEnv([entry("core"), entry("ui", ["core"]), entry("app", ["ui"])]),
    checkTarball: noop,
    publishTarball: ({ EXPECTED_NAME }) => publishes.push(EXPECTED_NAME),
    waitForPackages: async ({ packages }) => packages,
    writeOutput: noop,
  }), /npm is still missing @stll\/core@1.2.3.*Skipped dependents: @stll\/ui, @stll\/app/);
  assert.deepEqual(publishes, ["@stll/core"]);
});

test("registry lookup errors block publication of dependents", async () => {
  const publishes = [];
  await assert.rejects(publishReleaseEntries({
    env: planEnv([entry("core"), entry("ui", ["core"])]),
    checkTarball: noop,
    publishTarball: ({ EXPECTED_NAME }) => publishes.push(EXPECTED_NAME),
    readRegistryState: () => { throw new Error("registry unavailable"); },
    writeOutput: noop,
  }), /registry unavailable.*Skipped dependents: @stll\/ui/);
  assert.deepEqual(publishes, ["@stll/core"]);
});

test("a failure of the final entry reports no skipped dependents", async () => {
  const outputs = [];
  await assert.rejects(publishReleaseEntries({
    env: planEnv([entry("core")]),
    checkTarball: noop,
    publishTarball: () => { throw new Error("publish failed"); },
    writeOutput: (name, values) => outputs.push([name, values]),
  }), /Skipped dependents: none/);
  assert.deepEqual(outputs.at(-1), ["skipped-dependents", []]);
});

for (const value of ["0", "-1", "invalid", "Infinity", "46"]) {
  test(`invalid visibility timeout ${value} fails before publication`, async () => {
    await assert.rejects(publishReleaseEntries({
      env: planEnv([entry("core")], { NPM_VISIBILITY_TIMEOUT_MINUTES: value }),
      checkTarball: () => assert.fail("timeout should fail before path checks"),
      publishTarball: () => assert.fail("invalid timeout must not publish"),
    }), /must be a positive number no greater than 45/);
  });
}

for (const [value, minutes] of [[undefined, 20], ["", 20], ["45", 45], ["0.5", 0.5]]) {
  test(`visibility timeout ${String(value)} resolves to ${minutes} minutes`, async () => {
    await publishReleaseEntries({
      env: planEnv([entry("core")], { NPM_VISIBILITY_TIMEOUT_MINUTES: value }),
      now: () => 0,
      checkTarball: noop,
      publishTarball: noop,
      waitForPackages: async ({ timeoutMinutes }) => { assert.equal(timeoutMinutes, minutes); return []; },
      writeOutput: noop,
    });
  });
}

test("rejects invalid plan shapes and ordering before publishing", async () => {
  const plan = [entry("core"), entry("ui", ["core"])];
  const mutations = [
    { PUBLISH_PLAN: "null" },
    { PUBLISH_PLAN: "{}" },
    { PUBLISH_PLAN: "[]" },
    { PUBLISH_PLAN: "{" },
    { TARBALL: "extra.tgz" },
    { EXPECTED_NAME: "@stll/core" },
    { EXPECTED_VERSION: "1.2.3" },
    { TARBALLS: "ui.tgz\ncore.tgz" },
    { TARBALLS: "core.tgz" },
    { PUBLISH_PLAN: JSON.stringify([entry("core"), entry("core")]) },
    { PUBLISH_PLAN: JSON.stringify([entry("ui", ["core"]), entry("core")]), TARBALLS: "ui.tgz\ncore.tgz" },
    { PUBLISH_PLAN: JSON.stringify([entry("core", ["missing"]), entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([entry("core", ["core"]), entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([entry("core", ["ui"]), entry("ui", ["core"])]) },
    { PUBLISH_PLAN: JSON.stringify([{ ...entry("core"), dependencies: [null] }, entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([{ ...entry("core"), dependencies: "core" }, entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([{ ...entry("core"), name: "@stll/core\nforged" }, entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([{ ...entry("core"), version: null }, entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([{ ...entry("core"), path: null }, entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([null, entry("ui")]) },
    { PUBLISH_PLAN: JSON.stringify([entry("core"), { ...entry("ui"), path: "core.tgz" }]), TARBALLS: "core.tgz\ncore.tgz" },
  ];
  for (const mutation of mutations) {
    await assert.rejects(publishReleaseEntries({
      env: planEnv(plan, mutation),
      checkTarball: () => assert.fail("invalid plan must fail before path checks"),
      publishTarball: () => assert.fail("invalid plan must not publish"),
    }));
  }
});

test("accepts CRLF tarball inputs and retains literal paths with spaces", () => {
  const plan = [{ ...entry("core"), path: "release artifacts/core.tgz" }, entry("ui", ["core"])];
  assert.deepEqual(validatePublishPlan(validationInput(plan, { tarballs: "release artifacts/core.tgz\r\nui.tgz\r\n" })), plan);
});


test("visibility waits share the plan budget rather than multiplying it per package", async () => {
  let elapsed = 0;
  const budgets = [];
  await publishReleaseEntries({
    env: planEnv([entry("core"), entry("ui", ["core"])], { NPM_VISIBILITY_TIMEOUT_MINUTES: "7" }),
    now: () => elapsed,
    checkTarball: noop,
    publishTarball: noop,
    waitForPackages: async ({ timeoutMinutes }) => {
      budgets.push(timeoutMinutes);
      elapsed += 60_000;
      return [];
    },
    writeOutput: noop,
  });
  assert.deepEqual(budgets, [7, 6]);
});

test("an exhausted plan budget prevents starting the next publication", async () => {
  let elapsed = 0;
  const publishes = [];
  await assert.rejects(publishReleaseEntries({
    env: planEnv([entry("core"), entry("ui", ["core"]), entry("app", ["ui"])]),
    now: () => elapsed,
    checkTarball: noop,
    publishTarball: ({ EXPECTED_NAME }) => publishes.push(EXPECTED_NAME),
    waitForPackages: async () => { elapsed += 20 * 60_000; return []; },
    writeOutput: noop,
  }), /Failed to publish @stll\/ui@1.2.3.*budget exhausted.*Skipped dependents: @stll\/app/);
  assert.deepEqual(publishes, ["@stll/core"]);
});
