import { expect, test } from "bun:test";
import { auditConsumers, checkPinAge, inspectCaller, REQUIRED_BOTS } from "./cla-consumers";

const sha = "a".repeat(40);
const caller = (condition = "github.event_name == 'pull_request_target' || (github.event_name == 'issue_comment')") => `
on:
  pull_request_target:
    types: [opened, synchronize, reopened, closed]
jobs:
  cla:
    if: >-
      ${condition}
    uses: stella/.github/.github/workflows/cla.yml@${sha}
    with:
      allowlist: ${REQUIRED_BOTS.join(",")}
`;

test("accepts an unconditional PR arm, with or without parentheses", () => {
  expect(inspectCaller(caller())).toBe(sha);
  expect(inspectCaller(caller("(github.event_name == 'pull_request_target') || (github.event_name == 'issue_comment')"))).toBe(sha);
  expect(inspectCaller(caller("!github.event.repository.private && ((github.event_name == 'pull_request_target') || (github.event_name == 'issue_comment'))"))).toBe(sha);
});

test("rejects filters in the PR arm for every allowlisted bot", () => {
  for (const bot of REQUIRED_BOTS) {
    expect(() => inspectCaller(caller(`(github.event_name == 'pull_request_target' && github.event.pull_request.user.login != '${bot}') || (github.event_name == 'issue_comment')`))).toThrow("including bots");
    expect(() => inspectCaller(caller().replace(bot, "other-user"))).toThrow("missing allowlisted bot");
  }
  expect(() => inspectCaller(caller("github.actor != 'dependabot[bot]'"))).toThrow("including bots");
  expect(() => inspectCaller(caller().replace("types:", "branches-ignore: ['dependabot/**']\n    types:"))).toThrow("every pull request");
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
    if (path.includes("/commits/")) return { commit: { committer: { date: new Date().toISOString() } } };
    return { content: Buffer.from(caller()).toString("base64") };
  };
  await expect(auditConsumers({ repositories: ["broken", "good", "also-good"], maxPinAgeDays: 30 }, api)).rejects.toThrow("broken: GitHub API 404");
  expect(visited.filter((path) => path.includes("/contents/")).length).toBe(3);
  expect(visited.filter((path) => path.includes("/commits/")).length).toBe(1);
});
