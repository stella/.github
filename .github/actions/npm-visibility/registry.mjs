import { spawnSync } from "node:child_process";

const defaultAttempt = (command, args) =>
  spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const isNotFound = (result) =>
  /(?:HTTP 404|E404|404 Not Found)/.test(result.stderr ?? "");
const fail = (message) => {
  throw new Error(message);
};

// The per-version document is served before the package document lists a new
// version, which can lag a publish by about 30 minutes. Treat a 200 there as
// proof the version exists; anything else falls back to `npm view`.
const npmVersionDocumentState = (name, version, attempt) => {
  const result = attempt("curl", [
    "-sS",
    "--max-time",
    "30",
    "-w",
    "\n%{http_code}",
    `https://registry.npmjs.org/${name}/${version}`,
  ]);
  if (result.status !== 0) return null;
  const split = result.stdout.lastIndexOf("\n");
  if (result.stdout.slice(split + 1) !== "200") return null;
  const metadata = JSON.parse(result.stdout.slice(0, split));
  if (metadata.version !== version) return null;
  return {
    exists: true,
    integrity: metadata.dist?.integrity ?? null,
    tarball: metadata.dist?.tarball ?? null,
  };
};

export const readNpmState = (name, version, attempt = defaultAttempt) => {
  const spec = `${name}@${version}`;
  const versionDocument = npmVersionDocumentState(name, version, attempt);
  if (versionDocument) return versionDocument;
  const result = attempt("npm", [
    "view",
    spec,
    "version",
    "dist.integrity",
    "dist.tarball",
    "--json",
  ]);
  if (result.status !== 0) {
    if (isNotFound(result))
      return { exists: false, integrity: null, tarball: null };
    fail(`npm registry lookup failed for ${spec}: ${result.stderr.trim()}`);
  }
  const metadata = JSON.parse(result.stdout);
  if (metadata.version !== version) {
    fail(`npm returned '${metadata.version}' for ${spec}.`);
  }
  return {
    exists: true,
    integrity: metadata["dist.integrity"] ?? metadata.dist?.integrity ?? null,
    tarball: metadata["dist.tarball"] ?? metadata.dist?.tarball ?? null,
  };
};
