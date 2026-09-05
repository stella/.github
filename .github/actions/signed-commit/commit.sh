#!/usr/bin/env bash
# Commit the working tree's changes under PATHS to BRANCH through the GitHub
# API. GitHub signs commits it creates and attributes them to the token's
# owner, so the result passes a "require signed commits" rule with no key on
# the runner. See action.yml for the contract.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${MODE:?MODE is required}"
: "${BRANCH:?BRANCH is required}"
: "${PATHS:?PATHS is required}"
: "${COMMIT_MESSAGE:?COMMIT_MESSAGE is required}"
BASE="${BASE:-}"
PR_TITLE="${PR_TITLE:-}"
PR_BODY="${PR_BODY:-}"
MAX_COMMIT_BYTES="${MAX_COMMIT_BYTES:-20000000}"
ACTION_PATH="${ACTION_PATH:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

MODE_REFRESH_PR="refresh-pr"
MODE_APPEND="append"

fail() {
  echo "::error::$*" >&2
  exit 1
}

# A ref name reaches API paths and a push refspec, so it must be a plain
# branch name: nothing that reads as an option, a path traversal, or a glob.
validate_branch_name() {
  case "$2" in
    '' | -* | *..* | /* | */ | *' '* | *[!A-Za-z0-9._/-]*)
      fail "Invalid $1: '$2'"
      ;;
  esac
}

validate_branch_name branch "$BRANCH"
case "$MODE" in
  "$MODE_REFRESH_PR")
    validate_branch_name base "$BASE"
    [ -n "$PR_TITLE" ] || fail "pr-title is required in $MODE_REFRESH_PR mode"
    ;;
  "$MODE_APPEND") ;;
  *)
    fail "Unknown mode '$MODE' (expected $MODE_REFRESH_PR or $MODE_APPEND)"
    ;;
esac
case "$MAX_COMMIT_BYTES" in
  '' | *[!0-9]*)
    fail "max-commit-bytes must be a positive integer, got '$MAX_COMMIT_BYTES'"
    ;;
esac

repo="$GITHUB_REPOSITORY"
# The proposal is built here and only then swapped under BRANCH. Moving an
# open pull request's head straight to the base commit would make GitHub
# close that pull request; a proposal-to-proposal force update keeps it open.
build_branch="$BRANCH-next"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pathspecs=()
while IFS= read -r line; do
  [ -n "$line" ] && pathspecs+=("$line")
done <<< "$PATHS"
[ "${#pathspecs[@]}" -gt 0 ] || fail "paths must name at least one pathspec"

# A reusable workflow checks this action out inside the caller's workspace.
# That checkout is untracked there and must never ride along in the commit,
# so it is excluded whenever the action lives in an untracked top-level
# directory. A caller-local action (a tracked `.github/actions/...`) is not.
if [ -d "$ACTION_PATH" ]; then
  # Physical paths on both sides: a workspace reached through a symlink
  # (macOS temp dirs) must still match.
  action_dir="$(cd "$ACTION_PATH" && pwd -P)"
  workspace="$(pwd -P)"
  case "$action_dir" in
    "$workspace"/*)
      relative="${action_dir#"$workspace"/}"
      top="${relative%%/*}"
      if ! git ls-files --error-unmatch -- "$top" > /dev/null 2>&1; then
        pathspecs+=(":(exclude)$top")
      fi
      ;;
  esac
fi

# The staged diff is the single source for change detection and the payload:
# `-A` records new files and deletions alongside modifications.
git add -A -- "${pathspecs[@]}"
git diff --cached --name-status --no-renames -z > "$work/changes"

additions=()
deletions=()
while IFS= read -r -d '' status && IFS= read -r -d '' path; do
  case "$status" in
    A | M | T) additions+=("$path") ;;
    D) deletions+=("$path") ;;
    *) fail "Unsupported change '$status' for $path" ;;
  esac
done < "$work/changes"

# Bash 3.2 (macOS) rejects "${arr[@]}" on an empty array under `set -u`.
for path in ${additions[@]+"${additions[@]}"}; do
  mode="$(git ls-files --stage -- "$path" | cut -c1-6)"
  case "$mode" in
    120000 | 160000)
      fail "$path is a symlink or submodule; the API commit path carries regular files only"
      ;;
  esac
done

ref_exists() {
  gh api "repos/$repo/git/ref/heads/$1" --silent > /dev/null 2>&1
}

# Force is deliberate: BRANCH and its build branch are reserved for this job,
# so an update only ever replaces this job's own prior proposal.
set_ref() {
  if ref_exists "$1"; then
    gh api -X PATCH "repos/$repo/git/refs/heads/$1" -f sha="$2" -F force=true --silent
  else
    gh api -X POST "repos/$repo/git/refs" -f ref="refs/heads/$1" -f sha="$2" --silent
  fi
}

delete_ref_if_exists() {
  if ref_exists "$1"; then
    gh api -X DELETE "repos/$repo/git/refs/heads/$1" --silent
  fi
}

number=""
url=""

find_open_pr() {
  gh pr list --repo "$repo" --head "$BRANCH" --base "$BASE" --state open \
    --json number,url --jq '.[0] // empty | "\(.number) \(.url)"'
}

write_outputs() {
  {
    echo "operation=$1"
    echo "commit-sha=$2"
    echo "pull-request-number=$number"
    echo "pull-request-url=$url"
  } >> "$GITHUB_OUTPUT"
}

if [ "${#additions[@]}" -eq 0 ] && [ "${#deletions[@]}" -eq 0 ]; then
  if [ "$MODE" = "$MODE_APPEND" ]; then
    echo "No changes under the managed paths; nothing to commit." >> "$GITHUB_STEP_SUMMARY"
    write_outputs none ""
    exit 0
  fi
  # A stale proposal is withdrawn as soon as base no longer needs it.
  read -r number url <<< "$(find_open_pr)"
  operation=none
  if [ -n "$number" ]; then
    gh pr close --repo "$repo" "$number"
    operation=closed
    echo "Closed $url: base already contains these changes." >> "$GITHUB_STEP_SUMMARY"
  else
    echo "No changes under the managed paths; nothing to propose." >> "$GITHUB_STEP_SUMMARY"
  fi
  delete_ref_if_exists "$BRANCH"
  delete_ref_if_exists "$build_branch"
  write_outputs "$operation" ""
  exit 0
fi

head_oid="$(git rev-parse HEAD)"

if [ "$MODE" = "$MODE_REFRESH_PR" ]; then
  target_branch="$build_branch"
  set_ref "$build_branch" "$head_oid"
else
  target_branch="$BRANCH"
fi

headline="${COMMIT_MESSAGE%%$'\n'*}"
body="$(printf '%s\n' "$COMMIT_MESSAGE" | sed '1d' | sed '/./,$!d')"

# shellcheck disable=SC2016 # $input is a GraphQL variable, not shell
query='mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'
expected_oid="$head_oid"
commits=0
chunk_bytes=0
chunk_files=0
: > "$work/additions.ndjson"
: > "$work/deletions.ndjson"

# One createCommitOnBranch call per chunk. `expectedHeadOid` makes the
# sequence atomic against concurrent pushes: a foreign commit on the branch
# fails the call instead of being silently built upon.
send_commit() {
  jq -cn \
    --arg query "$query" \
    --arg repo "$repo" \
    --arg branch "$target_branch" \
    --arg headline "$headline" \
    --arg body "$body" \
    --arg oid "$expected_oid" \
    --slurpfile additions "$work/additions.ndjson" \
    --slurpfile deletions "$work/deletions.ndjson" \
    '{
      query: $query,
      variables: {
        input: {
          branch: { repositoryNameWithOwner: $repo, branchName: $branch },
          message: { headline: $headline, body: (if $body == "" then null else $body end) },
          expectedHeadOid: $oid,
          fileChanges: { additions: $additions, deletions: $deletions }
        }
      }
    }' > "$work/request.json"
  expected_oid="$(gh api graphql --input "$work/request.json" \
    --jq '.data.createCommitOnBranch.commit.oid')"
  [ -n "$expected_oid" ] || fail "createCommitOnBranch returned no commit oid"
  commits=$((commits + 1))
  chunk_bytes=0
  chunk_files=0
  : > "$work/additions.ndjson"
  : > "$work/deletions.ndjson"
}

for path in ${additions[@]+"${additions[@]}"}; do
  size="$(wc -c < "$path" | tr -d ' ')"
  if [ "$chunk_files" -gt 0 ] && [ $((chunk_bytes + size)) -gt "$MAX_COMMIT_BYTES" ]; then
    send_commit
  fi
  base64 < "$path" | tr -d '\n' > "$work/contents.b64"
  jq -cn --arg path "$path" --rawfile contents "$work/contents.b64" \
    '{ path: $path, contents: $contents }' >> "$work/additions.ndjson"
  chunk_bytes=$((chunk_bytes + size))
  chunk_files=$((chunk_files + 1))
done
for path in ${deletions[@]+"${deletions[@]}"}; do
  jq -cn --arg path "$path" '{ path: $path }' >> "$work/deletions.ndjson"
  chunk_files=$((chunk_files + 1))
done
send_commit

if [ "$MODE" = "$MODE_REFRESH_PR" ]; then
  set_ref "$BRANCH" "$expected_oid"
  delete_ref_if_exists "$build_branch"
fi

{
  echo "### Committed to \`$BRANCH\` ($commits commit(s), signed by GitHub)"
  echo
  for path in ${additions[@]+"${additions[@]}"}; do echo "- $path"; done
  for path in ${deletions[@]+"${deletions[@]}"}; do echo "- $path (deleted)"; done
} >> "$GITHUB_STEP_SUMMARY"

if [ "$MODE" = "$MODE_APPEND" ]; then
  write_outputs committed "$expected_oid"
  exit 0
fi

printf '%s' "$PR_BODY" > "$work/pr-body.md"
read -r number url <<< "$(find_open_pr)"
if [ -n "$number" ]; then
  gh pr edit --repo "$repo" "$number" --title "$PR_TITLE" --body-file "$work/pr-body.md"
  operation=updated
else
  url="$(gh pr create --repo "$repo" --base "$BASE" --head "$BRANCH" \
    --title "$PR_TITLE" --body-file "$work/pr-body.md")"
  number="${url##*/}"
  operation=created
fi
echo "" >> "$GITHUB_STEP_SUMMARY"
echo "Pull request: $url ($operation)" >> "$GITHUB_STEP_SUMMARY"
write_outputs "$operation" "$expected_oid"
