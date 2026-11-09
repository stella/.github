import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findNonLinuxFullSuites } from "./non-linux-full-suite.mjs";

const release = readFileSync(new URL("./rust-napi-release.yml", import.meta.url), "utf8");

test("native release behavior keeps repository-wide tests on Linux", () => {
  expect(release).toContain("if: runner.os == 'Linux'\n        run: bun test");
  expect(release).toContain("if: runner.os != 'Linux'");
  expect(release).toContain('run: bun test "./$BINDING_TEST_DIRECTORY"');
  expect(findNonLinuxFullSuites(release)).toEqual([]);
});
