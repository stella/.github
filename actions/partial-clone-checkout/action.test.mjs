import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const actionUrl = new URL("./action.yml", import.meta.url);
const checkoutSha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const inputs = [
  "repository",
  "ref",
  "token",
  "ssh-key",
  "ssh-known-hosts",
  "ssh-strict",
  "ssh-user",
  "persist-credentials",
  "path",
  "clean",
  "sparse-checkout",
  "sparse-checkout-cone-mode",
  "fetch-depth",
  "fetch-tags",
  "show-progress",
  "lfs",
  "submodules",
  "set-safe-directory",
  "github-server-url",
  "allow-unsafe-pr-checkout",
];

const parse = (source) => JSON.parse(
  execFileSync(
    "ruby",
    ["-rjson", "-ryaml", "-e", "puts JSON.generate(YAML.safe_load(STDIN.read, aliases: true))"],
    { encoding: "utf8", input: source },
  ),
);

const assertCheckoutContract = (source) => {
  const action = parse(source);
  assert.deepEqual(Object.keys(action.inputs), inputs);

  const [first, retry, verify] = action.runs.steps;
  for (const step of [first, retry]) {
    assert.equal(step.uses, `actions/checkout@${checkoutSha}`);
    assert.equal(step.with.filter, "blob:none");
    for (const input of inputs) {
      assert.equal(step.with[input], `\${{ inputs.${input} }}`);
    }
    assert.deepEqual(Object.keys(step.with).sort(), [...inputs, "filter"].sort());
  }

  assert.equal(first["continue-on-error"], true);
  assert.equal(retry.if, "steps.checkout.outcome == 'failure'");
  assert.match(verify.env.FIRST_COMMIT, /steps\.checkout\.outputs\.commit/u);
  assert.match(verify.env.RETRY_COMMIT, /steps\.retry\.outputs\.commit/u);
  assert.match(verify.run, /git -C .* rev-parse HEAD/u);
};

test("both checkout attempts pass the complete pinned partial-clone contract", () => {
  assertCheckoutContract(readFileSync(actionUrl, "utf8"));
});

test("dropping any retry input violates the checkout contract", () => {
  const source = readFileSync(actionUrl, "utf8").replace(
    /(?<=    - name: Retry checkout[\s\S]*?      with:[\s\S]*?)^        repository:.*\n/mu,
    "",
  );
  assert.throws(() => assertCheckoutContract(source), assert.AssertionError);
});
