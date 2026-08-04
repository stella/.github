#!/usr/bin/env bash
# Apply the org label manifest to one or more repositories.
#
# Usage: sync-labels.sh <plan|apply|apply-with-prune> <owner/repo>...
#
# plan             report the diff, change nothing
# apply            create missing labels, correct colors and descriptions
# apply-with-prune additionally delete labels absent from the manifest,
#                  but only when nothing references them
#
# The manifest is labels.yml, the org-wide baseline, plus labels/<repo>.yml
# when that repo has product-specific labels. Overlay entries win on name
# collision.
#
# Pruning skips any label still applied to an issue or pull request, so a
# label a bot introduced and is still using survives until it is declared or
# retired deliberately.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$REPO_ROOT/labels.yml"

MODE="${1:-}"
shift || true

case "$MODE" in
  plan | apply | apply-with-prune) ;;
  *)
    echo "error: mode must be plan, apply, or apply-with-prune" >&2
    exit 1
    ;;
esac

if [[ $# -eq 0 ]]; then
  echo "error: no repositories given" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "error: manifest not found at $MANIFEST" >&2
  exit 1
fi

created=0 updated=0 pruned=0 kept=0

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# name<TAB>color<TAB>description for the given repo: the org baseline, with
# labels/<repo>.yml merged on top when it exists. An overlay entry replaces a
# baseline entry of the same name, so a repo can retune a shared label without
# forking the whole manifest.
manifest_tsv() {
  local overlay="$REPO_ROOT/labels/${1##*/}.yml"
  local overlay_json='[]'
  [[ -f "$overlay" ]] && overlay_json="$(yq -o=json '.' "$overlay")"

  jq -rn --argjson base "$(yq -o=json '.' "$MANIFEST")" --argjson extra "$overlay_json" '
    ($base + $extra)
    | group_by(.name) | map(.[-1])
    | .[] | [.name, .color, (.description // "")] | @tsv'
}

for slug in "$@"; do
  if [[ "$slug" != */* ]]; then
    echo "error: expected owner/repo, got '$slug'" >&2
    exit 1
  fi
  echo
  echo "=== $slug"

  if ! live="$(gh api "repos/$slug/labels" --paginate 2>/dev/null)"; then
    echo "  skipped: cannot read labels (missing repo or insufficient token scope)"
    continue
  fi

  while IFS=$'\t' read -r name color description; do
    [[ -z "$name" ]] && continue

    current="$(jq -r --arg n "$name" \
      '.[] | select(.name == $n) | [.color, (.description // "")] | @tsv' <<<"$live")"

    if [[ -z "$current" ]]; then
      echo "  + create  $name"
      created=$((created + 1))
      [[ "$MODE" == plan ]] && continue
      gh api -X POST "repos/$slug/labels" \
        -f "name=$name" -f "color=$color" -f "description=$description" >/dev/null
      continue
    fi

    IFS=$'\t' read -r live_color live_description <<<"$current"
    changes=""
    [[ "$(lower "$live_color")" != "$(lower "$color")" ]] &&
      changes="color #$live_color -> #$color"
    if [[ "$live_description" != "$description" ]]; then
      [[ -n "$changes" ]] && changes="$changes, "
      changes="${changes}description \"$live_description\" -> \"$description\""
    fi

    if [[ -n "$changes" ]]; then
      echo "  ~ update  $name ($changes)"
      updated=$((updated + 1))
      [[ "$MODE" == plan ]] && continue
      gh api -X PATCH "repos/$slug/labels/$name" \
        -f "new_name=$name" -f "color=$color" -f "description=$description" >/dev/null
    fi
  done < <(manifest_tsv "$slug")

  # plan previews deletions as well as additions: a destructive run must be
  # reviewable before it happens. Only apply-with-prune actually deletes.
  [[ "$MODE" == apply ]] && continue

  known="$(manifest_tsv "$slug" | cut -f1)"
  while read -r name; do
    [[ -z "$name" ]] && continue
    grep -qxF "$name" <<<"$known" && continue

    # Refuse to delete anything still referenced; count issues and PRs alike.
    in_use="$(gh api -X GET "repos/$slug/issues" \
      -f "labels=$name" -f state=all -f per_page=1 --jq 'length')"
    if [[ "$in_use" -gt 0 ]]; then
      echo "  = keep    $name (still in use)"
      kept=$((kept + 1))
      continue
    fi

    echo "  - prune   $name"
    pruned=$((pruned + 1))
    [[ "$MODE" == plan ]] && continue
    gh api -X DELETE "repos/$slug/labels/$name" >/dev/null
  done < <(jq -r '.[].name' <<<"$live")
done

echo
echo "create=$created update=$updated prune=$pruned keep=$kept mode=$MODE"
