import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  auditConsumers,
  checkPinAge,
  inspectCaller,
  inspectReusable,
  REQUIRED_BOTS,
  validateCallerContract,
} from "./cla-consumers";

const sha = "a".repeat(40);
const reusable = readFileSync(new URL("../workflows/cla.yml", import.meta.url), "utf8");
const contract = inspectReusable(reusable);
const commentArm =
  "(github.event_name == 'issue_comment' && github.event.issue.pull_request && (github.event.comment.body == 'recheck' || github.event.comment.body == 'I have read the CLA Document and I hereby sign the CLA'))";
const secretExpression = (name: string) => `\${{ secrets.${name} }}`;
const caller = (condition = `github.event_name == 'pull_request_target' || ${commentArm}`) => `
on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened, synchronize, reopened, closed]
permissions:
${Array.from(contract.permissions, ([scope, access]) => `  ${scope}: ${access}`).join("\n")}
jobs:
  cla:
    if: >-
      ${condition}
    uses: stella/.github/.github/workflows/cla.yml@${sha}
    secrets:
${Array.from(contract.secrets.keys(), (name) => `      ${name}: ${secretExpression(name)}`).join("\n")}
    with:
      allowlist: ${REQUIRED_BOTS.join(",")}
`;

const validate = (source: string) => validateCallerContract(inspectCaller(source), contract);

test("accepts an unconditional PR arm, with or without parentheses", () => {
  expect(inspectCaller(caller()).sha).toBe(sha);
  expect(
    inspectCaller(caller(`(github.event_name == 'pull_request_target') || ${commentArm}`)).sha,
  ).toBe(sha);
  expect(
    inspectCaller(
      caller(
        `!github.event.repository.private && ((github.event_name == 'pull_request_target') || ${commentArm})`,
      ),
    ).sha,
  ).toBe(sha);
});

test("rejects filters in the PR arm for every allowlisted bot", () => {
  for (const bot of REQUIRED_BOTS) {
    expect(() =>
      inspectCaller(
        caller(
          `(github.event_name == 'pull_request_target' && github.event.pull_request.user.login != '${bot}') || (github.event_name == 'issue_comment')`,
        ),
      ),
    ).toThrow("including bots");
    expect(() => inspectCaller(caller().replace(bot, "other-user"))).toThrow(
      "missing allowlisted bot",
    );
  }
  expect(() => inspectCaller(caller("github.actor != 'dependabot[bot]'"))).toThrow(
    "including bots",
  );
  expect(() =>
    inspectCaller(
      caller(
        `(github.event_name == 'pull_request_target' || ${commentArm}) && github.actor != 'dependabot[bot]'`,
      ),
    ),
  ).toThrow("including bots");
  expect(() =>
    inspectCaller(
      caller().replace(
        "  pull_request_target:\n",
        "  pull_request_target:\n    branches-ignore: ['dependabot/**']\n",
      ),
    ),
  ).toThrow("every pull request");
});

test("rejects floating, old, future and invalid pins", () => {
  expect(() => inspectCaller(caller().replace(sha, "main"))).toThrow("full commit SHA");
  const now = Date.parse("2026-10-17T00:00:00Z");
  checkPinAge("2026-09-17T00:00:00Z", 30, now);
  for (const date of ["2026-09-16T23:59:59Z", "2026-10-18T00:00:00Z", "invalid"]) {
    expect(() => checkPinAge(date, 30, now)).toThrow("at most 30 days");
  }
});

test("audits every repository and fetches each pinned contract once", async () => {
  const visited: string[] = [];
  const api = async (path: string) => {
    visited.push(path);
    if (path.includes("/broken/")) throw new Error("GitHub API 404");
    if (path.includes("?ref=")) return { content: Buffer.from(reusable).toString("base64") };
    if (path.includes("/commits/"))
      return { commit: { committer: { date: new Date().toISOString() } } };
    return { content: Buffer.from(caller()).toString("base64") };
  };
  await expect(
    auditConsumers({ repositories: ["broken", "good", "also-good"], maxPinAgeDays: 30 }, api),
  ).rejects.toThrow("broken: GitHub API 404");
  expect(
    visited.filter((path) => path.endsWith("/contents/.github/workflows/cla.yml")),
  ).toHaveLength(3);
  expect(visited.filter((path) => path.includes("?ref="))).toEqual([
    `repos/stella/.github/contents/.github/workflows/cla.yml?ref=${sha}`,
  ]);
  expect(visited.filter((path) => path.includes("/commits/"))).toHaveLength(1);
});

test("the canonical shared verifier defines its caller contract", () => {
  expect(contract.permissions.size).toBeGreaterThan(0);
  validate(caller());
});

test("requires every permission requested by the pinned workflow at the effective caller scope", () => {
  for (const [scope, access] of contract.permissions) {
    if (access === "none") continue;
    expect(() => validate(caller().replace(`  ${scope}: ${access}\n`, ""))).toThrow(
      `requires ${scope}: ${access}`,
    );
    expect(() =>
      validate(caller().replace(`  ${scope}: ${access}\n`, `  ${scope}: none\n`)),
    ).toThrow(`requires ${scope}: ${access}`);
  }
  const jobPermissions = Array.from(
    contract.permissions,
    ([scope, access]) => `      ${scope}: ${access}`,
  ).join("\n");
  validate(caller().replace("  cla:\n", `  cla:\n    permissions:\n${jobPermissions}\n`));
  expect(() => validate(caller().replace("  cla:\n", "  cla:\n    permissions: {}\n"))).toThrow(
    "CLA caller requires",
  );
  validate(caller().replace("  contents: read\n", "  contents: write\n"));
  const jobPermission = inspectReusable(
    reusable.replace("  cla:\n", "  cla:\n    permissions:\n      deployments: write\n"),
  );
  expect(() => validateCallerContract(inspectCaller(caller()), jobPermission)).toThrow(
    "requires deployments: write",
  );
});

test("rejects undeclared caller inputs and secrets", () => {
  expect(() =>
    validate(caller().replace("    with:\n", "    with:\n      undeclared_input: value\n")),
  ).toThrow("undeclared CLA inputs: undeclared_input");
  expect(() =>
    validate(
      caller().replace(
        "    secrets:\n",
        `    secrets:\n      OTHER_SECRET: ${secretExpression("OTHER_SECRET")}\n`,
      ),
    ),
  ).toThrow("undeclared CLA secrets: OTHER_SECRET");
});

test("requires the inputs and secrets declared required by the pinned workflow", () => {
  const requiredSecrets = Array.from(contract.secrets).filter(
    ([, definition]) => definition.required,
  );
  expect(requiredSecrets.length).toBeGreaterThan(0);
  for (const [name] of requiredSecrets) {
    expect(() =>
      validate(caller().replace(`      ${name}: ${secretExpression(name)}\n`, "")),
    ).toThrow(`missing required CLA secrets: ${name}`);
  }
  const requiredInput = inspectReusable(
    reusable.replace(
      "    inputs:\n",
      "    inputs:\n      required_input:\n        type: string\n        required: true\n",
    ),
  );
  expect(() => validateCallerContract(inspectCaller(caller()), requiredInput)).toThrow(
    "missing required CLA inputs: required_input",
  );
});

test("rejects malformed reusable declarations and implicit caller secrets", () => {
  expect(() => inspectReusable(reusable.replace("workflow_call:", "workflow_dispatch:"))).toThrow(
    "expose workflow_call",
  );
  expect(() => inspectReusable(reusable.replace("  checks: write", "  checks: invalid"))).toThrow(
    "invalid CLA permission: checks",
  );
  expect(() => inspectReusable(reusable.replace("required: true", "required: invalid"))).toThrow(
    "required must be boolean",
  );
  expect(() => inspectReusable(reusable.replace("type: string", "type: invalid"))).toThrow(
    "workflow_call type",
  );
  const inherited = caller().replace(
    /    secrets:\n(?:      [^\n]+\n)+/u,
    "    secrets: inherit\n",
  );
  expect(() => inspectCaller(inherited)).toThrow("explicit CLA caller secrets must be a mapping");
});

test("surfaces missing or incompatible pinned reusable workflow contents", async () => {
  for (const pinned of [{}, { content: Buffer.from("on: {}\njobs: {}\n").toString("base64") }]) {
    const api = async (path: string) => {
      if (path.includes("?ref=")) return pinned;
      if (path.includes("/commits/"))
        return { commit: { committer: { date: new Date().toISOString() } } };
      return { content: Buffer.from(caller()).toString("base64") };
    };
    await expect(
      auditConsumers({ repositories: ["good"], maxPinAgeDays: 30 }, api),
    ).rejects.toThrow();
  }
});

test("requires PR lifecycle and signing-comment trigger coverage", () => {
  expect(
    inspectCaller(caller().replace("    types: [opened, synchronize, reopened, closed]\n", "")).sha,
  ).toBe(sha);
  expect(inspectCaller(caller().replace("    types: [created]\n", "")).sha).toBe(sha);
  for (const event of ["opened", "synchronize", "reopened"]) {
    expect(() => inspectCaller(caller().replace(event, "edited"))).toThrow(
      "opened, synchronize and reopened",
    );
  }
  expect(() =>
    inspectCaller(caller().replace("  issue_comment:\n    types: [created]\n", "")),
  ).toThrow("created signing comments");
  expect(() => inspectCaller(caller().replace("types: [created]", "types: [edited]"))).toThrow(
    "created signing comments",
  );
});
