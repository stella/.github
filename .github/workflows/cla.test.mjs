import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const workflow = readFileSync(new URL("./cla.yml", import.meta.url), "utf8");
const source = workflow.split("          script: |\n")[1].split("\n").map((line) => line.slice(12)).join("\n");
const sha = (letter) => letter.repeat(40);
const BASE = sha("b"), HEAD = sha("a"), SECOND = sha("c"), GROUP = sha("9"), PREVIOUS = sha("8");
const author = { id: 101, login: "contributor", type: "User" };
const other = { id: 102, login: "other-contributor", type: "User" };
const sentence = "I have read the CLA Document and I hereby sign the CLA";
const pull = (number = 17, user = author, head = HEAD) => ({
  number, user, state: "open", commits: 1, head: { sha: head },
  base: { sha: BASE, ref: "main", repo: { id: 200, full_name: "fixture/repository" } },
});
const entries = [
  { headCommit: { oid: GROUP }, baseCommit: { oid: PREVIOUS }, pullRequest: { number: 17 } },
  { headCommit: { oid: PREVIOUS }, baseCommit: { oid: BASE }, pullRequest: { number: 18 } },
];
const group = { head_sha: GROUP, base_sha: BASE, base_ref: "refs/heads/main", head_ref: "refs/heads/gh-readonly-queue/main/pr-17-abcdef" };

async function fixture({
  event = "pull_request_target", payload = { pull_request: { number: 17 } },
  pulls = [pull()], signed = [author.id], allowlist = "", comments = [],
  queue = entries, superseded = false, changedHead = false, invalidShape = false,
  unlinked = false, members = [], storeFailure = false, incompleteCommits = false,
} = {}) {
  const created = [], updates = [], errors = [], requests = [];
  let queueReads = 0, pullReads = 0;
  class Api {
    constructor({ auth = "repository-token" } = {}) { this.auth = auth; }
    async request(route, params) {
      requests.push({ route, params, auth: this.auth });
      if (route.endsWith("/check-runs")) {
        assert.equal(this.auth, "repository-token");
        created.push(params); return { data: { id: created.length } };
      }
      if (route.endsWith("/check-runs/{check_run_id}")) {
        updates.push(params); return { data: {} };
      }
      if (route.includes("/contents/")) {
        assert.equal(this.auth, "store-token");
        if (storeFailure) throw Object.assign(new Error("Unavailable"), { status: 403 });
        if (route.startsWith("PUT")) return { data: {} };
        return { data: { type: "file", encoding: "base64", sha: sha("d"), content: Buffer.from(JSON.stringify({ signedContributors: signed.map((id) => ({ id })) })).toString("base64") } };
      }
      if (route.includes("/memberships/")) {
        assert.equal(this.auth, "store-token");
        if (members.includes(params.username)) return { data: { state: "active", role: "member" } };
        throw Object.assign(new Error("Not a member"), { status: 404 });
      }
      if (route === "GET /users/{username}") {
        return { data: pulls.map((p) => p.user).find((u) => u.login === params.username) };
      }
      if (route.endsWith("/pulls/{pull_number}")) {
        const selected = pulls.find((p) => p.number === params.pull_number);
        assert.ok(selected);
        pullReads++;
        return { data: changedHead && pullReads > 1 ? { ...selected, head: { sha: SECOND } } : selected };
      }
      if (route.endsWith("/compare/{basehead}")) {
        const entry = entries.find((e) => `${e.baseCommit.oid}...${e.headCommit.oid}` === params.basehead);
        if (entry) return { data: { total_commits: 1, commits: [{ sha: entry.headCommit.oid, parents: [{ sha: invalidShape ? HEAD : entry.baseCommit.oid }] }] } };
        const selected = pulls.find((p) => `${p.base.sha}...${p.head.sha}` === params.basehead);
        assert.ok(selected);
        return { data: { total_commits: 1, commits: [{ sha: selected.head.sha }] } };
      }
      if (route.includes("/comments")) return { data: {} };
      throw new Error(`Unmocked request: ${route}`);
    }
    paginate = { iterator: async function* (route, params) {
      if (route.endsWith("/commits")) {
        const selected = pulls.find((p) => p.number === params.pull_number);
        yield { data: incompleteCommits ? [] : [{ sha: selected.head.sha }] }; return;
      }
      if (route.endsWith("/comments")) { yield { data: comments }; return; }
      throw new Error(`Unmocked pagination: ${route}`);
    } };
    async graphql(query, params) {
      if (query.includes("mergeQueue")) {
        queueReads++;
        return { repository: { mergeQueue: { entries: { nodes: superseded && queueReads > 1 ? [] : queue, pageInfo: { hasNextPage: false } } } } };
      }
      const selected = pulls.find((p) => p.head.sha === params.oid);
      assert.ok(selected);
      return { repository: { object: { oid: params.oid, authors: {
        totalCount: 1, nodes: [{ user: unlinked ? null : { databaseId: selected.user.id, login: selected.user.login } }],
        pageInfo: { hasNextPage: false },
      } } } };
    }
  }
  await runInNewContext(`(async () => {${source}\n})()`, {
    github: new Api(), context: { repo: { owner: "fixture", repo: "repository" }, eventName: event, payload },
    core: { setFailed: (message) => errors.push(message), error: () => {} },
    process: { env: { CLA_STORE_TOKEN: "store-token", CLA_ALLOWLIST: allowlist } },
    Buffer, setTimeout,
  });
  return { created, updates, errors, requests };
}

const conclusions = (result) => result.updates.map((check) => check.conclusion);
test("signed PR reports both shared and scoped checks on its head", async () => {
  const result = await fixture();
  assert.deepEqual(conclusions(result), ["success", "success"]);
  assert.deepEqual(result.created.map((check) => [check.name, check.head_sha]), [["cla", HEAD], ["cla/pr-17", HEAD]]);
  assert.deepEqual(result.errors, []);
});
test("unsigned PR fails and receives a signing prompt", async () => {
  const result = await fixture({ signed: [] });
  assert.deepEqual(conclusions(result), ["failure", "failure"]);
  assert.ok(result.errors.includes("CLA_UNSIGNED"));
  assert.ok(result.requests.some(({ route }) => route.startsWith("POST") && route.includes("/comments")));
});
test("merge group verifies both signed PRs on the group head", async () => {
  const result = await fixture({ event: "merge_group", payload: { merge_group: group }, pulls: [pull(), pull(18, other, SECOND)], signed: [author.id, other.id] });
  assert.deepEqual(conclusions(result), ["success"]);
  assert.equal(result.created[0].head_sha, GROUP);
});
test("merge group fails when its predecessor PR is unsigned", async () => {
  const result = await fixture({ event: "merge_group", payload: { merge_group: group }, pulls: [pull(), pull(18, other, SECOND)] });
  assert.deepEqual(conclusions(result), ["failure"]);
  assert.match(result.updates[0].output.summary, /other-contributor \(#18\)/u);
});
test("superseded group is neutral only after observing the old head disappear", async () => {
  const result = await fixture({ event: "merge_group", payload: { merge_group: group }, superseded: true, changedHead: true });
  assert.deepEqual(conclusions(result), ["neutral"]);
  assert.equal(result.updates[0].output.title, "CLA_GROUP_SUPERSEDED");
});
test("a never-observed group fails closed", async () => {
  const result = await fixture({ event: "merge_group", payload: { merge_group: group }, queue: [] });
  assert.deepEqual(conclusions(result), ["failure"]);
  assert.match(result.errors[0], /CLA_INCOMPLETE_MERGE_GROUP/u);
});
test("invalid squash ancestry fails closed", async () => {
  const result = await fixture({ event: "merge_group", payload: { merge_group: group }, invalidShape: true });
  assert.deepEqual(conclusions(result), ["failure"]);
  assert.match(result.errors[0], /CLA_UNEXPECTED_GROUP_COMMIT/u);
});
for (const [login, allowlist] of [["service[bot]", "service[bot]"], ["Service[bot]", "service*"], ["service[bot]", " , service[bot], "]]) {
  test(`allowlist matches ${login} using ${allowlist}`, async () => {
    assert.deepEqual(conclusions(await fixture({ pulls: [pull(17, { ...author, login })], signed: [], allowlist })), ["success", "success"]);
  });
}
test("allowlist escapes regex syntax and anchors patterns", async () => {
  assert.deepEqual(conclusions(await fixture({ signed: [], allowlist: "contribut.*,contribut,contributor[bot]" })), ["failure", "failure"]);
});
test("bot and active organization member exemptions do not read signatures", async () => {
  for (const options of [{ pulls: [pull(17, { ...author, type: "Bot" })] }, { members: [author.login] }]) {
    const result = await fixture({ ...options, signed: [] });
    assert.deepEqual(conclusions(result), ["success", "success"]);
    assert.ok(!result.requests.some(({ route }) => route.includes("/contents/")));
  }
});
test("unlinked commit author cannot pass", async () => {
  assert.deepEqual(conclusions(await fixture({ unlinked: true })), ["failure", "failure"]);
});
test("incomplete commit list and signature read failure fail closed", async () => {
  for (const options of [{ incompleteCommits: true }, { storeFailure: true }]) {
    const result = await fixture(options);
    assert.deepEqual(conclusions(result), ["failure"]);
    assert.equal(result.errors.length, 1);
  }
});
test("signing comment records the identity and rechecks the PR", async () => {
  const result = await fixture({ event: "issue_comment", payload: { issue: { number: 17, pull_request: {} } }, signed: [], comments: [{ id: 302, user: author, body: sentence, created_at: "2026-10-01T00:00:00Z" }] });
  assert.deepEqual(conclusions(result), ["success", "success"]);
  assert.ok(result.requests.some(({ route }) => route.startsWith("PUT")));
});
test("manual dispatch validates input and deduplicates PR numbers", async () => {
  const result = await fixture({ event: "workflow_dispatch", payload: { inputs: { pull_requests: "17, 17" } } });
  assert.deepEqual(conclusions(result), ["success", "success"]);
  for (const input of ["", "17;code", "-1", "0"]) {
    assert.equal((await fixture({ event: "workflow_dispatch", payload: { inputs: { pull_requests: input } } })).errors.length, 1);
  }
});
test("privileged verifier stays API-only and keeps the reusable contract", () => {
  assert.doesNotMatch(workflow, /actions\/checkout|\brun:|contributor-assistant\/github-action/u);
  assert.match(workflow, /# Never check out PR head code, build or install it, or interpolate PR data into/u);
  assert.match(workflow, /app-id: \$\{\{ inputs.app-id \}\}/u);
  assert.match(workflow, /CLA_ALLOWLIST: \$\{\{ inputs.allowlist \}\}/u);
  assert.match(workflow, /checks: write/u);
  const caller = readFileSync(new URL("./cla-check.yml", import.meta.url), "utf8");
  assert.match(caller, /merge_group:\n    types: \[checks_requested\]/u);
  assert.match(caller, /group: cla-\$\{\{ github.event.pull_request.number \|\| github.event.issue.number \|\| github.run_id \}\}/u);
});
