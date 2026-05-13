#!/usr/bin/env bash
# Hardened npm publish via OIDC trusted publishing, tarball flavor.
# See action.yml for the contract.

set -euo pipefail

# Defence in depth: trusted publishing performs auth via the OIDC token
# exchange. If a legacy token is in env, the publish below would silently
# fall back to bearer auth and the whole point of this action is lost.
if [[ -n "${NPM_TOKEN:-}" || -n "${NODE_AUTH_TOKEN:-}" ]]; then
  printf '::error::NPM_TOKEN/NODE_AUTH_TOKEN must not be set when using %s\n' \
    "the hardened publish action — trusted publishing only." >&2
  exit 2
fi

# npm 11.5.1 introduced trusted publishing support. Older clients silently
# skip the OIDC exchange and try anonymous publish → 401.
NPM_VERSION=$(npm --version)
IFS='.' read -r NPM_MAJOR NPM_MINOR NPM_PATCH <<<"${NPM_VERSION}"
# Strip any pre-release suffix from the patch component (e.g. "1-beta.0").
NPM_PATCH=${NPM_PATCH%%-*}
NPM_MAJOR=${NPM_MAJOR:-0}
NPM_MINOR=${NPM_MINOR:-0}
NPM_PATCH=${NPM_PATCH:-0}
if (( NPM_MAJOR < 11 )) \
   || (( NPM_MAJOR == 11 && NPM_MINOR < 5 )) \
   || (( NPM_MAJOR == 11 && NPM_MINOR == 5 && NPM_PATCH < 1 )); then
  printf '::error::npm %s is too old; trusted publishing requires 11.5.1+.\n' \
    "${NPM_VERSION}" >&2
  exit 2
fi

if [[ -z "${TARBALL:-}" ]]; then
  # shellcheck disable=SC2016
  printf '::error::Required input `tarball` is empty.\n' >&2
  exit 2
fi
if [[ ! -f "${TARBALL}" ]]; then
  printf '::error::Tarball not found: %s\n' "${TARBALL}" >&2
  exit 2
fi

# Resolve to absolute path so npm publish works regardless of cwd.
TARBALL=$(realpath "${TARBALL}")

# Extract name and version from the tarball's bundled package.json
# rather than the working tree — the published artifact is whatever
# bytes are in the .tgz, so the idempotency check must reflect that.
# Use node for the JSON parse since it's already a hard requirement
# (we verified the npm version above) — `jq` is not listed as a
# caller prerequisite and is not present on every runner.
PKG_JSON_FILE="${RUNNER_TEMP:-/tmp}/npm-publish-hardened-pkg-$$.json"
trap 'rm -f "${PKG_JSON_FILE}"' EXIT
tar -xOf "${TARBALL}" package/package.json > "${PKG_JSON_FILE}"

read -r PACKAGE_NAME PACKAGE_VERSION < <(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write((j.name ?? "") + "\t" + (j.version ?? ""));
' "${PKG_JSON_FILE}")

if [[ -z "${PACKAGE_NAME}" || "${PACKAGE_NAME}" == "null" \
   || -z "${PACKAGE_VERSION}" || "${PACKAGE_VERSION}" == "null" ]]; then
  printf '::error::Failed to read name/version from %s/package.json.\n' \
    "${TARBALL}" >&2
  exit 2
fi

# Idempotency: skip if exact version is already published. `npm view`
# exits non-zero when the version doesn't exist, so the && guard handles
# both "not published" and any view-time errors uniformly.
already_published() {
  local seen
  seen=$(npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version 2>/dev/null) || return 1
  [[ "${seen}" == "${PACKAGE_VERSION}" ]]
}

if already_published; then
  printf '::notice::%s@%s already published; skipping.\n' \
    "${PACKAGE_NAME}" "${PACKAGE_VERSION}"
  exit 0
fi

# Publish, with retries. npm 11.5+ auto-detects
# ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (set
# by GitHub Actions when the calling job has `id-token: write`) and
# exchanges the OIDC token for a one-shot registry token. --provenance
# generates the SLSA v1 attestation.
#
# Two failure modes the retry handles:
#   1. transient registry / network error (5xx, TLS, DNS) — `npm
#      publish` fails outright; we retry the publish.
#   2. registry eventual consistency — `npm publish` returns non-zero
#      but the artifact was actually accepted; the `already_published`
#      check between attempts catches that and exits cleanly.
PUBLISH_LOG="${RUNNER_TEMP:-/tmp}/npm-publish-${PACKAGE_NAME//\//-}.log"
MAX_ATTEMPTS=5
for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
  if npm publish "${TARBALL}" --provenance --access public --tag "${DIST_TAG}" 2>"${PUBLISH_LOG}"; then
    exit 0
  fi

  cat "${PUBLISH_LOG}" >&2

  if already_published; then
    printf '::notice::%s@%s became visible after publish attempt %d; treating as success.\n' \
      "${PACKAGE_NAME}" "${PACKAGE_VERSION}" "${attempt}"
    exit 0
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    break
  fi

  # Backoff between publish attempts: 5s, 10s, 15s, 20s (50s total).
  sleep $((attempt * 5))
done

# After all publish attempts failed, give the registry a final
# eventual-consistency window: sometimes the last publish was actually
# accepted but visibility lags behind the API response by a few seconds.
for poll in 1 2 3 4 5; do
  sleep "${poll}"
  if already_published; then
    printf '::notice::%s@%s became visible after final publish failure; treating as success.\n' \
      "${PACKAGE_NAME}" "${PACKAGE_VERSION}"
    exit 0
  fi
done

printf '::error::Failed to publish %s@%s after %d attempts and post-failure polling.\n' \
  "${PACKAGE_NAME}" "${PACKAGE_VERSION}" "${MAX_ATTEMPTS}" >&2
exit 1
