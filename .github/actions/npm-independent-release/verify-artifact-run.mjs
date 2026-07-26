import { execFileSync } from "node:child_process";
import process from "node:process";

import { validateArtifactRun } from "./state.mjs";

const fail = (message) => {
  throw new Error(message);
};

const githubJson = (endpoint) =>
  JSON.parse(
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

try {
  const artifactRunId = process.env.ARTIFACT_RUN_ID;
  const currentRunId = process.env.GITHUB_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  const sourceSha = process.env.SOURCE_SHA;
  if (!/^\d+$/.test(artifactRunId ?? "")) {
    fail("ARTIFACT_RUN_ID must be a numeric GitHub Actions run ID.");
  }
  if (!/^\d+$/.test(currentRunId ?? "")) {
    fail("GITHUB_RUN_ID must be a numeric GitHub Actions run ID.");
  }
  if (!repository) fail("GITHUB_REPOSITORY is required.");
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    fail("SOURCE_SHA must be a full lowercase commit SHA.");
  }

  validateArtifactRun({
    artifactRun: githubJson(
      `repos/${repository}/actions/runs/${artifactRunId}`,
    ),
    currentRun: githubJson(`repos/${repository}/actions/runs/${currentRunId}`),
    sourceSha,
  });
  console.log(
    `::notice::Recovery artifacts verified from run ${artifactRunId} at ${sourceSha}.`,
  );
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
