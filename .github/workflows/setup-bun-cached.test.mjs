import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actionUrl = new URL("../../actions/setup-bun-cached/action.yml", import.meta.url);

const assertCacheContract = (action) => {
  assert.match(action, /name: Setup Bun\n      id: setup-bun\n/u);
  const caches = action.split(/    - name: Restore Bun install cache[^\n]*\n/u).slice(1);
  assert.equal(caches.length, 2);
  for (const cache of caches) {
    assert.match(cache, /path: ~\/\.bun\/install\/cache/u);
    assert.ok(
      cache.includes(
        "key: bun-install-${{ runner.os }}-${{ steps.setup-bun.outputs.bun-version }}-${{ hashFiles('bun.lock') }}",
      ),
    );
    assert.ok(
      cache.includes(
        "restore-keys: |\n          bun-install-${{ runner.os }}-${{ steps.setup-bun.outputs.bun-version }}-\n",
      ),
    );
    assert.doesNotMatch(cache, /path:.*node_modules/u);
  }
  assert.match(caches[0], /if: inputs\.install-cache == 'actions' && inputs\.save != 'false'/u);
  assert.match(caches[0], /uses: actions\/cache@/u);
  assert.match(caches[1], /if: inputs\.install-cache == 'actions' && inputs\.save == 'false'/u);
  assert.match(caches[1], /uses: actions\/cache\/restore@/u);
};

test("both cache modes isolate packages by OS, installed Bun version and lockfile", async () => {
  assertCacheContract(await readFile(actionUrl, "utf8"));
});

test("rejects cache keys and fallbacks without the installed Bun version", async () => {
  const action = await readFile(actionUrl, "utf8");
  const version = "${{ steps.setup-bun.outputs.bun-version }}-";
  assert.equal(action.split(version).length - 1, 4);
  for (let occurrence = 0; occurrence < 4; occurrence += 1) {
    let seen = 0;
    const mutated = action.replaceAll(version, (match) => (seen++ === occurrence ? "" : match));
    assert.throws(() => assertCacheContract(mutated), assert.AssertionError);
  }
});

test("persistent runners opt out of the Actions cache explicitly, unknown modes fail", async () => {
  const action = await readFile(actionUrl, "utf8");
  assert.match(action, /  install-cache:\n[\s\S]*?    default: actions\n/u);
  assert.match(
    action,
    /- name: Check install cache mode\n      if: inputs\.install-cache != 'actions' && inputs\.install-cache != 'runner'\n[\s\S]*?exit 1\n/u,
  );
  assert.ok(
    action.indexOf("Check install cache mode") < action.indexOf("Restore Bun install cache"),
  );
  assert.throws(
    () => assertCacheContract(action.replaceAll("inputs.install-cache == 'actions' && ", "")),
    assert.AssertionError,
  );
});
