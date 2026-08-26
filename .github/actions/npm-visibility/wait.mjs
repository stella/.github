const NPM_VISIBILITY_RECHECK_DELAYS_MILLISECONDS = [
  5_000, 10_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000,
];

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const waitForNpmPackages = async ({
  packages,
  readNpmState,
  recheckDelays = NPM_VISIBILITY_RECHECK_DELAYS_MILLISECONDS,
  wait = sleep,
}) => {
  let missing = packages.filter(
    (pkg) => !readNpmState(pkg.name, pkg.version).exists,
  );
  for (const delay of recheckDelays) {
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
