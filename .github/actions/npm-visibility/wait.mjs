// Short initial backoff for the common case (the registry usually exposes a
// version within seconds), then settle into a flat 60s poll for the rest of
// the budget: npm's read replicas can lag a successful `npm publish` by
// several minutes, and polling faster than that buys nothing.
const NPM_VISIBILITY_INITIAL_DELAYS_MILLISECONDS = [
  5_000, 10_000, 15_000, 30_000,
];
const NPM_VISIBILITY_POLL_INTERVAL_MILLISECONDS = 60_000;
export const NPM_VISIBILITY_DEFAULT_TIMEOUT_MINUTES = 20;

// GitHub Actions cannot derive a job's `timeout-minutes` from an input, so
// the release job in npm-independent-release.yml carries a fixed budget
// (55) for checkout, staging, npm publish, and this wait combined. Cap the
// input below that fixed budget, with margin for the earlier steps, so an
// over-large request fails fast here instead of getting silently cut off
// mid-poll when the runner kills the job. Keep this in sync with that
// workflow's `timeout-minutes`.
export const MAX_NPM_VISIBILITY_TIMEOUT_MINUTES = 45;

export const resolveNpmVisibilityTimeoutMinutes = (value) => {
  if (value === undefined || value === "") {
    return NPM_VISIBILITY_DEFAULT_TIMEOUT_MINUTES;
  }
  const minutes = Number(value);
  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    minutes > MAX_NPM_VISIBILITY_TIMEOUT_MINUTES
  ) {
    throw new Error(
      `npm-visibility-timeout-minutes must be a positive number no greater than ${MAX_NPM_VISIBILITY_TIMEOUT_MINUTES}; got '${value}'.`,
    );
  }
  return minutes;
};

// Builds a bounded backoff schedule that never waits past `timeoutMinutes`
// in total: the short initial ramp-up (trimmed if the budget is smaller
// than it), then a flat 60s poll for whatever budget remains.
export const buildNpmVisibilityRecheckDelays = (
  timeoutMinutes = NPM_VISIBILITY_DEFAULT_TIMEOUT_MINUTES,
) => {
  const budgetMilliseconds = timeoutMinutes * 60_000;
  const delays = [];
  let elapsed = 0;
  for (const delay of NPM_VISIBILITY_INITIAL_DELAYS_MILLISECONDS) {
    if (elapsed + delay > budgetMilliseconds) break;
    delays.push(delay);
    elapsed += delay;
  }
  while (elapsed + NPM_VISIBILITY_POLL_INTERVAL_MILLISECONDS <= budgetMilliseconds) {
    delays.push(NPM_VISIBILITY_POLL_INTERVAL_MILLISECONDS);
    elapsed += NPM_VISIBILITY_POLL_INTERVAL_MILLISECONDS;
  }
  return delays;
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const waitForNpmPackages = async ({
  packages,
  readNpmState,
  recheckDelays,
  timeoutMinutes = NPM_VISIBILITY_DEFAULT_TIMEOUT_MINUTES,
  wait = sleep,
}) => {
  const delays = recheckDelays ?? buildNpmVisibilityRecheckDelays(timeoutMinutes);
  let missing = packages.filter(
    (pkg) => !readNpmState(pkg.name, pkg.version).exists,
  );
  for (const delay of delays) {
    if (missing.length === 0) return missing;
    console.log(
      `::notice::Waiting ${delay}ms for npm to expose published versions: ${missing.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
    );
    await wait(delay);
    missing = missing.filter(
      (pkg) => !readNpmState(pkg.name, pkg.version).exists,
    );
  }
  return missing;
};
