import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

// Cargo records the packaging commit here; every other entry is crate source.
const VCS_INFO = ".cargo_vcs_info.json";

const listFiles = (root, directory = root) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(root, path);
    }
    if (!entry.isFile()) {
      throw new Error(`crate archive contains a non-regular entry: ${relative(root, path)}`);
    }
    return [relative(root, path)];
  });

const unpack = (cratePath) => {
  const directory = mkdtempSync(join(tmpdir(), "crate-source-"));
  try {
    // -p keeps the archived permission bits instead of applying the umask.
    execFileSync("tar", ["-xpzf", cratePath, "-C", directory]);
    const files = new Map();
    for (const path of listFiles(directory)) {
      const [, ...inside] = path.split("/");
      if (inside.join("/") !== VCS_INFO) {
        const file = join(directory, path);
        files.set(path, { bytes: readFileSync(file), mode: statSync(file).mode & 0o7777 });
      }
    }
    return files;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** Paths whose bytes or permission bits differ between two crate archives, ignoring timestamps, owners and the VCS record. */
export const diffCrateSources = (leftCrate, rightCrate) => {
  const left = unpack(leftCrate);
  const right = unpack(rightCrate);
  const paths = new Set([...left.keys(), ...right.keys()]);
  return [...paths]
    .filter((path) => {
      const a = left.get(path);
      const b = right.get(path);
      return a === undefined || b === undefined || a.mode !== b.mode || !a.bytes.equals(b.bytes);
    })
    .sort();
};

const main = () => {
  const [leftCrate, rightCrate] = process.argv.slice(2);
  if (!(leftCrate && rightCrate)) {
    throw new Error("usage: crate-source-diff.mjs <crate> <crate>");
  }
  const differences = diffCrateSources(leftCrate, rightCrate);
  for (const path of differences) {
    console.log(path);
  }
  process.exitCode = differences.length === 0 ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
