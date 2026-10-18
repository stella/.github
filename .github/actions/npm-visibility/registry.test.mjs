import assert from "node:assert/strict";
import test from "node:test";

import { readNpmState } from "./registry.mjs";

const name = "@stll/core";
const version = "1.2.3";
const dist = { integrity: "sha512-example", tarball: "https://registry.npmjs.org/@stll/core/-/core-1.2.3.tgz" };
const ok = (stdout) => ({ status: 0, stdout, stderr: "" });

test("uses the exact version document before the package index", () => {
  const calls = [];
  const result = readNpmState(name, version, (command, args) => {
    calls.push([command, args]);
    assert.equal(command, "curl");
    assert.equal(args.at(-1), `https://registry.npmjs.org/${name}/${version}`);
    return ok(`${JSON.stringify({ version, dist })}\n200`);
  });
  assert.deepEqual(result, { exists: true, ...dist });
  assert.equal(calls.length, 1);
});

for (const curl of [
  { status: 1, stderr: "network failure" },
  ok("not found\n404"),
  ok(`${JSON.stringify({ version: "9.9.9", dist })}\n200`),
]) {
  test(`falls back to npm view when the exact document is unavailable: ${JSON.stringify(curl)}`, () => {
    const calls = [];
    const result = readNpmState(name, version, (command, args) => {
      calls.push(command);
      if (command === "curl") return curl;
      assert.deepEqual(args, ["view", `${name}@${version}`, "version", "dist.integrity", "dist.tarball", "--json"]);
      return ok(JSON.stringify({ version, "dist.integrity": dist.integrity, "dist.tarball": dist.tarball }));
    });
    assert.deepEqual(result, { exists: true, ...dist });
    assert.deepEqual(calls, ["curl", "npm"]);
  });
}

test("accepts nested npm dist metadata", () => {
  assert.deepEqual(readNpmState(name, version, (command) => command === "curl"
    ? ok("missing\n404") : ok(JSON.stringify({ version, dist }))), { exists: true, ...dist });
});

test("returns missing for an npm E404", () => {
  assert.deepEqual(readNpmState(name, version, (command) => command === "curl"
    ? ok("missing\n404") : { status: 1, stderr: "npm error E404 Not Found" }), {
    exists: false, integrity: null, tarball: null,
  });
});

test("fails closed on registry errors and unexpected npm versions", () => {
  assert.throws(() => readNpmState(name, version, (command) => command === "curl"
    ? ok("missing\n404") : { status: 1, stderr: "authentication failed" }), /npm registry lookup failed.*authentication failed/);
  assert.throws(() => readNpmState(name, version, (command) => command === "curl"
    ? ok("missing\n404") : ok(JSON.stringify({ version: "9.9.9" }))), /npm returned '9.9.9'/);
});

test("missing dist metadata remains explicit", () => {
  assert.deepEqual(readNpmState(name, version, () => ok(`${JSON.stringify({ version })}\n200`)), {
    exists: true, integrity: null, tarball: null,
  });
});
