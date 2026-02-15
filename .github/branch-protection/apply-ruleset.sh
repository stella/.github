#!/usr/bin/env bash
#
# apply-ruleset.sh — create or update a GitHub repository ruleset.
#
# Idempotent: looks up the ruleset by name. If it exists, updates it
# (PUT); otherwise creates it (POST).
#
# Prerequisites:
#   - gh CLI authenticated with a token that has Administration: write
#     (e.g. a GitHub App installation token)
#   - jq
#
# Usage:
#   ./apply-ruleset.sh <owner/repo> <ruleset.json>
#
# Examples:
#   ./apply-ruleset.sh stella/stella .github/branch-protection/ruleset-main.json
#
#   # With a GitHub App token:
#   GH_TOKEN="$(mint-token)" ./apply-ruleset.sh stella/stella ruleset.json
#
# The script also supports adding the built-in GitHub Actions app as
# a bypass actor via --github-actions-bypass. This looks up the
# installation ID automatically and injects it into the payload.

set -euo pipefail

usage() {
  echo "Usage: $0 [--github-actions-bypass] <owner/repo> <ruleset.json>"
  exit 1
}

GITHUB_ACTIONS_BYPASS=false

while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --github-actions-bypass)
      GITHUB_ACTIONS_BYPASS=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if [ $# -ne 2 ]; then
  usage
fi

REPO="$1"
RULESET_FILE="$2"

if [ ! -f "${RULESET_FILE}" ]; then
  echo "Error: ruleset file not found: ${RULESET_FILE}"
  exit 1
fi

# Read the ruleset config.
PAYLOAD=$(cat "${RULESET_FILE}")
RULESET_NAME=$(echo "${PAYLOAD}" | jq -r '.name')

if [ -z "${RULESET_NAME}" ] || [ "${RULESET_NAME}" = "null" ]; then
  echo "Error: ruleset JSON must have a 'name' field."
  exit 1
fi

echo "Ruleset: ${RULESET_NAME}"
echo "Target repo: ${REPO}"

# Optionally inject the GitHub Actions bypass actor.
if [ "${GITHUB_ACTIONS_BYPASS}" = true ]; then
  echo "Looking up GitHub Actions app installation ID..."

  # The built-in GitHub Actions app slug is "github-actions".
  # We need the installation ID for the target repo.
  INSTALLATION_ID=$(
    gh api "/repos/${REPO}/installation" \
      --jq '.id' 2>/dev/null || true
  )

  if [ -z "${INSTALLATION_ID}" ]; then
    echo "Warning: could not find GitHub Actions installation ID."
    echo "The github-actions[bot] bypass will NOT be added."
    echo "You may need to add it manually in the GitHub UI."
  else
    echo "GitHub Actions installation ID: ${INSTALLATION_ID}"
    PAYLOAD=$(
      echo "${PAYLOAD}" | jq \
        --argjson id "${INSTALLATION_ID}" \
        '.bypass_actors += [{
          "actor_id": $id,
          "actor_type": "Integration",
          "bypass_mode": "always"
        }]'
    )
  fi
fi

# Check if the ruleset already exists.
echo "Checking for existing ruleset..."
EXISTING=$(
  gh api "repos/${REPO}/rulesets" \
    --paginate \
    --jq ".[] | select(.name == \"${RULESET_NAME}\") | .id"
)

if [ -n "${EXISTING}" ]; then
  RULESET_ID="${EXISTING}"
  echo "Found existing ruleset (ID: ${RULESET_ID}). Updating..."

  gh api "repos/${REPO}/rulesets/${RULESET_ID}" \
    --method PUT \
    --input - <<< "${PAYLOAD}" \
    --jq '{ id, name, enforcement, updated_at: .updated_at }'

  echo "Ruleset updated."
else
  echo "No existing ruleset found. Creating..."

  gh api "repos/${REPO}/rulesets" \
    --method POST \
    --input - <<< "${PAYLOAD}" \
    --jq '{ id, name, enforcement, created_at: .created_at }'

  echo "Ruleset created."
fi
