#!/usr/bin/env bash
# Hardened npm publish via OIDC trusted publishing, tarball flavor.
# See action.yml for the contract.

set -euo pipefail

# `actions/setup-node@v6` with `registry-url:` exports
# NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX as a literal placeholder, so
# its `.npmrc` template `_authToken=${NODE_AUTH_TOKEN}` expands to a
# non-empty (but useless) string. We must neutralise the placeholder
# WITHOUT leaving the variable unset — npm config does env-var
# expansion when reading .npmrc, and an unset variable can leak the
# literal `${NODE_AUTH_TOKEN}` syntax into the Authorization header
# instead of being treated as absent. Setting it to an empty string
# expands cleanly to `_authToken=` (no auth) and lets npm's OIDC
# trusted-publishing path take over.
readonly SETUP_NODE_PLACEHOLDER='XXXXX-XXXXX-XXXXX-XXXXX'
if [[ "${NODE_AUTH_TOKEN:-}" == "${SETUP_NODE_PLACEHOLDER}" ]]; then
  export NODE_AUTH_TOKEN=''
fi

# Defence in depth: trusted publishing performs auth via the OIDC token
# exchange. If a real legacy token is in env, the publish below would
# silently fall back to bearer auth and the whole point of this action
# is lost.
if [[ -n "${NPM_TOKEN:-}" || -n "${NODE_AUTH_TOKEN:-}" ]]; then
  # Workflow commands (::error::) must be written to stdout to be picked
  # up by the runner's annotation processor; >&2 suppresses the UI
  # annotation. This rule applies to every ::error:: line below as well.
  printf '::error::NPM_TOKEN/NODE_AUTH_TOKEN must not be set to a real %s\n' \
    "value when using the hardened publish action — trusted publishing only."
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
    "${NPM_VERSION}"
  exit 2
fi

# Build the publish queue from either `tarball` (singular) or `tarballs`
# (newline-separated). Exactly one of the two inputs must be non-empty.
declare -a PUBLISH_QUEUE=()
if [[ -n "${TARBALL:-}" && -n "${TARBALLS:-}" ]]; then
  # shellcheck disable=SC2016
  printf '::error::Set exactly one of `tarball` or `tarballs` — not both.\n'
  exit 2
fi
if [[ -n "${TARBALL:-}" ]]; then
  PUBLISH_QUEUE+=("${TARBALL}")
elif [[ -n "${TARBALLS:-}" ]]; then
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    PUBLISH_QUEUE+=("${line}")
  done <<<"${TARBALLS}"
fi
if (( ${#PUBLISH_QUEUE[@]} == 0 )); then
  # shellcheck disable=SC2016
  printf '::error::No tarballs to publish — set `tarball` or `tarballs`.\n'
  exit 2
fi

# Pre-validate every tarball exists before publishing anything, so a
# typo in the 5th entry doesn't surface after 4 successful publishes.
for i in "${!PUBLISH_QUEUE[@]}"; do
  if [[ ! -f "${PUBLISH_QUEUE[$i]}" ]]; then
    printf '::error::Tarball not found: %s\n' "${PUBLISH_QUEUE[$i]}"
    exit 2
  fi
  PUBLISH_QUEUE[i]=$(realpath "${PUBLISH_QUEUE[$i]}")
done

# Per-tarball publish routine. Shared by both single and multi modes.
PKG_JSON_FILE="${RUNNER_TEMP:-/tmp}/npm-publish-hardened-pkg-$$.json"
trap 'rm -f "${PKG_JSON_FILE}"' EXIT

pkg_name_from_tarball() {
  local tarball="$1"
  tar -xOf "${tarball}" package/package.json > "${PKG_JSON_FILE}"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(j.name ?? "");
  ' "${PKG_JSON_FILE}"
}

if [[ -n "${EXPECTED_NAME:-}" || -n "${EXPECTED_VERSION:-}" ]]; then
  if (( ${#PUBLISH_QUEUE[@]} != 1 )) || [[ -z "${EXPECTED_NAME:-}" || -z "${EXPECTED_VERSION:-}" ]]; then
    printf '::error::expected-name and expected-version must be set together for exactly one tarball.\n'
    exit 2
  fi
  tar -xOf "${PUBLISH_QUEUE[0]}" package/package.json > "${PKG_JSON_FILE}"
  read -r actual_name actual_version < <(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`${j.name ?? ""}\t${j.version ?? ""}`);
  ' "${PKG_JSON_FILE}")
  if [[ "${actual_name}" != "${EXPECTED_NAME}" || "${actual_version}" != "${EXPECTED_VERSION}" ]]; then
    printf '::error::Tarball contains %s@%s; expected %s@%s.\n' \
      "${actual_name}" "${actual_version}" "${EXPECTED_NAME}" "${EXPECTED_VERSION}"
    exit 2
  fi
fi

# Preflight: every package in the queue must already exist on the
# registry. OIDC trusted publishing cannot create a brand-new package —
# npm requires a package to exist before a trusted publisher can be
# configured for it — so a first-ever publish would otherwise burn all
# retries and fail late with an opaque ENEEDAUTH, after sibling
# packages already published. Fail fast, before publishing anything,
# with bootstrap instructions instead.
declare -a PREFLIGHT_MISSING=()
for tarball in "${PUBLISH_QUEUE[@]}"; do
  preflight_name=$(pkg_name_from_tarball "${tarball}")
  if [[ -z "${preflight_name}" || "${preflight_name}" == "null" ]]; then
    printf '::error::Failed to read package name from %s.\n' "${tarball}"
    exit 2
  fi
  if view_output=$(npm view "${preflight_name}" name 2>&1); then
    continue
  fi
  if grep -q 'E404' <<<"${view_output}"; then
    PREFLIGHT_MISSING+=("${preflight_name}")
  else
    # Transient registry error must not block an otherwise valid
    # release; the publish loop below has its own retries.
    printf '::warning::Could not verify %s exists on the registry; continuing.\n' \
      "${preflight_name}"
  fi
done
if (( ${#PREFLIGHT_MISSING[@]} > 0 )); then
  for preflight_name in "${PREFLIGHT_MISSING[@]}"; do
    printf '::error::%s has never been published. Trusted publishing cannot create new packages. Bootstrap it first: (1) npm publish a placeholder manually (e.g. version 0.0.1-placeholder.0 with --tag placeholder), (2) add a trusted publisher in the package settings on npmjs.com (allow "publish"), then re-run this workflow. Nothing was published in this run.\n' \
      "${preflight_name}"
  done
  exit 2
fi

publish_one() {
  local tarball="$1"
  local package_name package_version

  # Extract name and version from the tarball's bundled package.json
  # rather than the working tree — the published artifact is whatever
  # bytes are in the .tgz, so the idempotency check must reflect that.
  # Use node for the JSON parse since it's already a hard requirement
  # (we verified the npm version above) — `jq` is not listed as a
  # caller prerequisite and is not present on every runner.
  tar -xOf "${tarball}" package/package.json > "${PKG_JSON_FILE}"

  # shellcheck disable=SC2016  # JS template literals don't need shell expansion
  read -r package_name package_version < <(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    // console.log appends a trailing newline. The newline is required:
    // bash `read` returns non-zero on EOF without a delimiter even when
    // the variables were assigned, and under `set -e` that kills the
    // script silently right here.
    console.log(`${j.name ?? ""}\t${j.version ?? ""}`);
  ' "${PKG_JSON_FILE}")

  if [[ -z "${package_name}" || "${package_name}" == "null" \
     || -z "${package_version}" || "${package_version}" == "null" ]]; then
    printf '::error::Failed to read name/version from %s/package.json.\n' \
      "${tarball}"
    return 2
  fi

  # Idempotency: skip if exact version is already published.
  already_published() {
    local seen
    seen=$(npm view "${package_name}@${package_version}" version 2>/dev/null) || return 1
    [[ "${seen}" == "${package_version}" ]]
  }

  if already_published; then
    printf '::notice::%s@%s already published; skipping.\n' \
      "${package_name}" "${package_version}"
    return 0
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
  local publish_log
  publish_log="${RUNNER_TEMP:-/tmp}/npm-publish-${package_name//\//-}.log"
  local max_attempts=5
  local attempt
  for attempt in $(seq 1 "${max_attempts}"); do
    if npm publish "${tarball}" --provenance --access public --tag "${DIST_TAG}" 2>"${publish_log}"; then
      return 0
    fi

    cat "${publish_log}" >&2

    if already_published; then
      printf '::notice::%s@%s became visible after publish attempt %d; treating as success.\n' \
        "${package_name}" "${package_version}" "${attempt}"
      return 0
    fi

    if (( attempt == max_attempts )); then
      break
    fi

    # Backoff between publish attempts: 5s, 10s, 15s, 20s (50s total).
    sleep $((attempt * 5))
  done

  # After all publish attempts failed, give the registry a final
  # eventual-consistency window: sometimes the last publish was actually
  # accepted but visibility lags behind the API response by a few seconds.
  local poll
  for poll in 1 2 3 4 5; do
    sleep "${poll}"
    if already_published; then
      printf '::notice::%s@%s became visible after final publish failure; treating as success.\n' \
        "${package_name}" "${package_version}"
      return 0
    fi
  done

  printf '::error::Failed to publish %s@%s after %d attempts and post-failure polling.\n' \
    "${package_name}" "${package_version}" "${max_attempts}"
  return 1
}

# Sequential — order matters when a meta-package (e.g. napi-rs root)
# depends on its platform sub-packages being published first.
for tarball in "${PUBLISH_QUEUE[@]}"; do
  publish_one "${tarball}"
done
