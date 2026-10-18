import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { auditConsumers, checkPinAge, inspectCaller, inspectReusable, REQUIRED_BOTS, REQUIRED_PERMISSIONS } from "./cla-consumers";

const sha = "a".repeat(40);
const commentArm = "(github.event_name == 'issue_comment' && github.event.issue.pull_request && (github.event.comment.body == 'recheck' || github.event.comment.body == 'I have read the CLA Document and I hereby sign the CLA'))";
const caller = (condition = `github.event_name == 'pull_request_target' || ${commentArm}`) => `
on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened, synchronize, reopened, closed]
permissions:
${Object.entries(REQUIRED_PERMISSIONS).map(([scope, access]) => `  ${scope}: ${access}`).join("\n")}
jobs:
  cla:
    if: >-
      ${condition}
    uses: stella/.github/.github/workflows/cla.yml@${sha}
    secrets:
      CLA_APP_PRIVATE_KEY: \${{ secrets.CLA_APP_PRIVATE_KEY }}
    with:
      allowlist: ${REQUIRED_BOTS.join(",")}
`;

const reusable = readFileSync(new URL("../workflows/cla.yml", import.meta.url), "utf8");

test("accepts an unconditional PR arm, with or without parentheses", () => {
  expect(inspectCaller(caller())).toBe(sha);
  expect(inspectCaller(caller(`(github.event_name == 'pull_request_target') || ${commentArm}`))).toBe(sha);
  expect(inspectCaller(caller(`!github.event.repository.private && ((github.event_name == 'pull_request_target') || ${commentArm})`))).toBe(sha);
});

test("rejects filters in the PR arm for every allowlisted bot", () => {
  for (const bot of REQUIRED_BOTS) {
    expect(() => inspectCaller(caller(`(github.event_name == 'pull_request_target' && github.event.pull_request.user.login != '${bot}') || (github.event_name == 'issue_comment')`))).toThrow("including bots");
    expect(() => inspectCaller(caller().replace(bot, "other-user"))).toThrow("missing allowlisted bot");
  }
  expect(() => inspectCaller(caller("github.actor != 'dependabot[bot]'"))).toThrow("including bots");
  expect(() => inspectCaller(caller(`(github.event_name == 'pull_request_target' || ${commentArm}) && github.actor != 'dependabot[bot]'`))).toThrow("including bots");
  expect(() => inspectCaller(caller().replace("  pull_request_target:\n", "  pull_request_target:\n    branches-ignore: ['dependabot/**']\n"))).toThrow("every pull request");
});

test("rejects floating, old, future and invalid pins", () => {
  expect(() => inspectCaller(caller().replace(sha, "main"))).toThrow("full commit SHA");
  const now = Date.parse("2026-10-17T00:00:00Z");
  checkPinAge("2026-09-17T00:00:00Z", 30, now);
  for (const date of ["2026-09-16T23:59:59Z", "2026-10-18T00:00:00Z", "invalid"]) {
    expect(() => checkPinAge(date, 30, now)).toThrow("at most 30 days");
  }
});

test("audits every repository and surfaces API failures instead of skipping them", async () => {
  const visited: string[] = [];
  const api = async (path: string) => {
    visited.push(path);
    if (path.includes("/broken/")) throw new Error("GitHub API 404");
    if (path.includes("?ref=")) return { content: Buffer.from(reusable).toString("base64") };
    if (path.includes("/commits/")) return { commit: { committer: { date: new Date().toISOString() } } };
    return { content: Buffer.from(caller()).toString("base64") };
  };
  await expect(auditConsumers({ repositories: ["broken", "good", "also-good"], maxPinAgeDays: 30 }, api)).rejects.toThrow("broken: GitHub API 404");
  expect(visited.filter((path) => path.endsWith("/contents/.github/workflows/cla.yml")).length).toBe(3);
  expect(visited.filter((path) => path.includes("?ref=")).length).toBe(1);
  expect(visited.filter((path) => path.includes("/commits/")).length).toBe(1);
});


test("requires every reusable permission at the effective caller scope", () => {
  for (const [scope, access] of Object.entries(REQUIRED_PERMISSIONS)) {
    expect(() => inspectCaller(caller().replace(`  ${scope}: ${access}\n`, ""))).toThrow(`requires ${scope}: ${access}`);
    expect(() => inspectCaller(caller().replace(`  ${scope}: ${access}\n`, `  ${scope}: none\n`))).toThrow(`requires ${scope}: ${access}`);
  }
  const jobPermissions = Object.entries(REQUIRED_PERMISSIONS).map(([scope, access]) => `      ${scope}: ${access}`).join("\n");
  expect(inspectCaller(caller().replace("  cla:\n", `  cla:\n    permissions:\n${jobPermissions}\n`))).toBe(sha);
  expect(() => inspectCaller(caller().replace("  cla:\n", "  cla:\n    permissions: {}\n"))).toThrow("requires actions: write");
});

test("requires the caller secret and accepts inherited secrets", () => {
  expect(() => inspectCaller(caller().replace("    secrets:\n      CLA_APP_PRIVATE_KEY: \${{ secrets.CLA_APP_PRIVATE_KEY }}\n", ""))).toThrow("must forward CLA_APP_PRIVATE_KEY");
  expect(inspectCaller(caller().replace("    secrets:\n      CLA_APP_PRIVATE_KEY: \${{ secrets.CLA_APP_PRIVATE_KEY }}\n", "    secrets: inherit\n"))).toBe(sha);
});

test("validates the pinned reusable workflow without requiring an opener check", () => {
  inspectReusable(reusable);
  for (const [scope, access] of Object.entries(REQUIRED_PERMISSIONS)) {
    expect(() => inspectReusable(reusable.replace(`  ${scope}: ${access}\n`, ""))).toThrow(`requires ${scope}: ${access}`);
  }
  for (const source of [
    reusable.replace("      allowlist:", "      excluded:"),
    reusable.replace("required: true", "required: false"),
    reusable.replace("workflow_call:", "workflow_dispatch:"),
  ]) {
    expect(() => inspectReusable(source)).toThrow("shared caller contract");
  }
  expect(() => inspectReusable(reusable.replace(/(contributor-assistant\/github-action@)[a-f0-9]{40}/u, "$1main"))).toThrow("SHA-pinned contributor assistant");
  expect(() => inspectReusable(reusable.replace("${{ inputs.allowlist }}", "dependabot[bot]"))).toThrow("forward the caller allowlist");
});

test("surfaces missing or incompatible pinned reusable workflow contents", async () => {
  for (const pinned of [{}, { content: Buffer.from("on: {}\njobs: {}\n").toString("base64") }]) {
    const api = async (path: string) => {
      if (path.includes("?ref=")) return pinned;
      if (path.includes("/commits/")) return { commit: { committer: { date: new Date().toISOString() } } };
      return { content: Buffer.from(caller()).toString("base64") };
    };
    await expect(auditConsumers({ repositories: ["good"], maxPinAgeDays: 30 }, api)).rejects.toThrow();
  }
});


test("requires PR lifecycle and signing-comment trigger coverage", () => {
  expect(inspectCaller(caller().replace("    types: [opened, synchronize, reopened, closed]\n", ""))).toBe(sha);
  expect(inspectCaller(caller().replace("    types: [created]\n", ""))).toBe(sha);
  for (const event of ["opened", "synchronize", "reopened"]) {
    expect(() => inspectCaller(caller().replace(event, "edited"))).toThrow("opened, synchronize and reopened");
  }
  expect(() => inspectCaller(caller().replace("  issue_comment:\n    types: [created]\n", ""))).toThrow("created signing comments");
  expect(() => inspectCaller(caller().replace("types: [created]", "types: [edited]"))).toThrow("created signing comments");
});
