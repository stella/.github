import assert from "node:assert/strict";
import test from "node:test";

import { decide } from "../../actions/ci-result/decide.mjs";

const job = (result, outputs = {}) => ({ result, outputs });
const check = (needs, options = {}) => decide({ event: "push", needs, ...options });

test("failure and cancellation fail the aggregate", () => {
  assert.equal(check({ build: job("failure") }).ok, false);
  assert.equal(check({ build: job("cancelled") }).ok, false);
});

test("a skipped job must be explicitly allowed", () => {
  assert.equal(check({ docs: job("skipped") }).ok, false);
  const result = check({ docs: job("skipped") }, { allowSkipped: "docs" });
  assert.equal(result.ok, true);
  assert.match(result.lines[0], /skipped allowed; pass/u);
});

test("pull-request-only jobs may skip outside pull requests", () => {
  const needs = { changeset: job("skipped") };
  assert.equal(decide({ event: "merge_group", needs, pullRequestOnly: "changeset" }).ok, true);
  assert.equal(decide({ event: "pull_request", needs, pullRequestOnly: "changeset" }).ok, false);
});

test("a pull request requires its trusted output to be true", () => {
  const needs = { "trust-check": job("success", { trusted: "false" }) };
  assert.equal(decide({ event: "pull_request", needs, requireTrusted: "trust-check.trusted" }).ok, false);
  needs["trust-check"].outputs.trusted = "true";
  assert.equal(decide({ event: "pull_request", needs, requireTrusted: "trust-check.trusted" }).ok, true);
});

test("an empty needs object fails closed", () => {
  assert.deepEqual(check({}), { ok: false, lines: ["needs: empty (fail)"] });
});

test("unknown job ids in allow lists fail as likely typos", () => {
  const needs = { build: job("success") };
  assert.equal(check(needs, { allowSkipped: "buid" }).ok, false);
  assert.equal(check(needs, { pullRequestOnly: "cheangeset" }).ok, false);
});

test("successful jobs pass and every job produces a result line", () => {
  const result = check({ build: job("success"), test: job("success") });
  assert.equal(result.ok, true);
  assert.equal(result.lines.length, 2);
});
