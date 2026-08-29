#!/usr/bin/env bash
set -euo pipefail

: "${CRATE_DIRECTORY:?}"
: "${EXPECTED_CRATE_NAME:?}"

readonly manifest="${CRATE_DIRECTORY}/release.json"
readonly upload="${CRATE_DIRECTORY}/upload.bin"
test -f "${manifest}"
test -f "${upload}"

name="$(jq -er '.name' "${manifest}")"
version="$(jq -er '.version' "${manifest}")"
crate_file="$(jq -er '.crateFile' "${manifest}")"
upload_file="$(jq -er '.uploadFile' "${manifest}")"
[[ "${name}" == "${EXPECTED_CRATE_NAME}" ]]
[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
[[ "${crate_file}" == "${name}-${version}.crate" ]]
[[ "${upload_file}" == "upload.bin" ]]
test -f "${CRATE_DIRECTORY}/${crate_file}"

crate_sha="$(jq -er '.crateSha256' "${manifest}")"
upload_sha="$(jq -er '.uploadSha256' "${manifest}")"
[[ "${crate_sha}" =~ ^[0-9a-f]{64}$ ]]
[[ "${upload_sha}" =~ ^[0-9a-f]{64}$ ]]
echo "${crate_sha}  ${CRATE_DIRECTORY}/${crate_file}" | sha256sum --check --strict
echo "${upload_sha}  ${upload}" | sha256sum --check --strict

readonly user_agent="stella-shared-crate-publisher"

exact_archive_is_visible() {
  local prefix="$1"
  local response="${RUNNER_TEMP}/${prefix}-version.json"
  local status
  status="$(curl --proto '=https' --tlsv1.2 --retry 3 -sS \
    --connect-timeout 10 --max-time 60 --user-agent "${user_agent}" \
    --output "${response}" --write-out '%{http_code}' \
    "https://crates.io/api/v1/crates/${name}/${version}" || true)"
  [[ "${status}" == 200 ]] || return 1
  jq -e --arg version "${version}" '.version.num == $version' "${response}" >/dev/null

  local archive="${RUNNER_TEMP}/${prefix}.crate"
  local archive_status
  archive_status="$(curl --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --retry 3 -sS --connect-timeout 10 --max-time 60 \
    --user-agent "${user_agent}" --output "${archive}" --write-out '%{http_code}' \
    "https://crates.io/api/v1/crates/${name}/${version}/download" || true)"
  [[ "${archive_status}" == 200 ]] || return 1
  [[ "$(sha256sum "${archive}" | cut -d ' ' -f1)" == "${crate_sha}" ]]
}

version_response="${RUNNER_TEMP}/crate-version-preflight.json"
version_status="$(curl --proto '=https' --tlsv1.2 --retry 3 -sS \
  --connect-timeout 10 --max-time 60 --user-agent "${user_agent}" \
  --output "${version_response}" --write-out '%{http_code}' \
  "https://crates.io/api/v1/crates/${name}/${version}")"
case "${version_status}" in
  200)
    if ! exact_archive_is_visible preflight; then
      printf '::error::Existing crates.io archive does not match the prepared crate.\n'
      exit 1
    fi
    printf '::notice::%s %s already published with the exact prepared bytes.\n' "${name}" "${version}"
    exit 0
    ;;
  404) ;;
  *)
    printf '::error::crates.io returned HTTP %s during preflight.\n' "${version_status}"
    exit 1
    ;;
esac

: "${CRATES_IO_TOKEN:?}"
publish_response="${RUNNER_TEMP}/crate-publish-response.json"
# Do not retry this immutable PUT. A failed response can still mean the upload committed.
publish_status="$(curl --proto '=https' --tlsv1.2 -sS \
  --connect-timeout 30 --max-time 300 --request PUT \
  --header 'Accept: application/json' \
  --header "Authorization: ${CRATES_IO_TOKEN}" \
  --header 'Content-Type: application/octet-stream' \
  --data-binary @"${upload}" --output "${publish_response}" --write-out '%{http_code}' \
  https://crates.io/api/v1/crates/new || true)"

if [[ "${publish_status}" == 2* ]] &&
  jq -e '(.errors // []) | length == 0' "${publish_response}" >/dev/null; then
  :
else
  for attempt in {1..12}; do
    if exact_archive_is_visible ambiguous; then
      printf '::notice::The ambiguous upload committed %s %s.\n' "${name}" "${version}"
      exit 0
    fi
    sleep 5
  done
  jq -r '.errors[]?.detail // empty' "${publish_response}" 2>/dev/null || true
  printf '::error::crates.io upload returned HTTP %s; exact bytes are not visible.\n' "${publish_status}"
  exit 1
fi

for attempt in {1..12}; do
  if exact_archive_is_visible published; then
    exit 0
  fi
  if [[ "${attempt}" == 12 ]]; then
    printf '::error::%s %s is not available with the prepared bytes.\n' "${name}" "${version}"
    exit 1
  fi
  sleep 5
done
