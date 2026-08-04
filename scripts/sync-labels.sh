#!/usr/bin/env bash
# Apply labels.yml to one or more repositories.
#
# Usage: sync-labels.sh <plan|apply|apply-with-prune> <owner/repo>...
#
# plan             report the diff, change nothing
# apply            create missing labels, correct colors and descriptions
# apply-with-prune additionally delete labels absent from the manifest,
#                  but only when nothing references them
#
# Pruning skips any label still applied to an issue or pull request. A repo
# may legitimately carry labels beyond the org baseline (CI bots, product
# areas), so the manifest is a floor, not a whitelist.
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

# name<TAB>color<TAB>description, one per manifest entry.
manifest_tsv() {
  yq -o=json '.' "$MANIFEST" |
    jq -r '.[] | [.name, .color, (.description // "")] | @tsv'
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
  done < <(manifest_tsv)

  [[ "$MODE" != apply-with-prune ]] && continue

  known="$(manifest_tsv | cut -f1)"
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
    gh api -X DELETE "repos/$slug/labels/$name" >/dev/null
  done < <(jq -r '.[].name' <<<"$live")
done

echo
echo "create=$created update=$updated prune=$pruned keep=$kept mode=$MODE"
