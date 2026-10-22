#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: pr-monitor.sh [--repo owner/repo] [--interval seconds] [--employee-org org] [--allowlist file] [--include-non-employees] [--ignore-author login]... [--no-ignore-bots] [--include-self-comments] [--quiet-initial] <pr-number-or-url>

Read-only monitor for GitHub PR state, comments, review comments, reviews, and CI checks.
Prints one Markdown paragraph per meaningful change, then exits after merged or closed terminal state.

Comments from the authenticated GitHub user and routine bots (policies/author-defaults.sh)
are suppressed by default. Add more with --ignore-author
(repeatable; "[bot]" suffix optional), use --no-ignore-bots for routine bots, or use
--include-self-comments for your own activity. Comment and review events are filtered.
PRs owned by a TRUSTED_ORGS organization (squareup and block by default) allow its
members and TRUSTED_BOTS by default. Use
--employee-org org for another organization, or --allowlist file for a roster
(one login per line, optional # comments). --include-non-employees disables
this whitelist. Other repository owners default to an empty whitelist.
Existing self/bot exclusions still apply. A roster is loaded
once at startup; restart the monitor to refresh it. Loading failures stop startup.
Use --quiet-initial for detached delivery: the startup summary is written to
stderr for health logs, while only actionable existing feedback or failures are
emitted on stdout.
USAGE
}

REPO=""
INTERVAL="${PR_MONITOR_INTERVAL:-60}"
COMMENT_FETCH_ATTEMPTS="${PR_MONITOR_COMMENT_FETCH_ATTEMPTS:-3}"
COMMENT_FETCH_RETRY_DELAY="${PR_MONITOR_COMMENT_FETCH_RETRY_DELAY:-1}"
COMMENT_HEALTH_FAILURE_THRESHOLD="${PR_MONITOR_COMMENT_HEALTH_FAILURE_THRESHOLD:-5}"
PR=""
EMPLOYEE_ORG=""
AUTHOR_ALLOWLIST_FILE=""
INCLUDE_NON_EMPLOYEES=0
ALLOWED_AUTHORS=""
AUTHOR_ALLOWLIST_ENABLED=0
INCLUDE_SELF_COMMENTS=0
QUIET_INITIAL=0
ONCE=0
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AUTHOR_DEFAULTS="${MONITOR_PR_AUTHOR_DEFAULTS:-$SCRIPT_DIR/policies/author-defaults.sh}"
[[ -f "$AUTHOR_DEFAULTS" ]] || { echo "ERROR: author defaults not found: $AUTHOR_DEFAULTS" >&2; exit 1; }
TRUSTED_ORGS="" TRUSTED_BOTS="" IGNORE_AUTHORS=""
# shellcheck disable=SC1090
source "$AUTHOR_DEFAULTS"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --employee-org) EMPLOYEE_ORG="$2"; shift 2;;
    --allowlist) AUTHOR_ALLOWLIST_FILE="$2"; shift 2;;
    --include-non-employees) INCLUDE_NON_EMPLOYEES=1; shift;;
    --ignore-author) IGNORE_AUTHORS+=$'\n'"${2%\[bot\]}"; shift 2;;
    --no-ignore-bots) IGNORE_AUTHORS=""; shift;;
    --include-self-comments) INCLUDE_SELF_COMMENTS=1; shift;;
    --quiet-initial) QUIET_INITIAL=1; shift;;
    --once) ONCE=1; shift;;
    -h|--help) usage; exit 0;;
    *)
      if [[ -n "$PR" ]]; then
        echo "ERROR: unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      PR="$1"
      shift
      ;;
  esac
done

if [[ -z "$PR" ]]; then usage >&2; exit 1; fi
if [[ "$PR" =~ github\.com/([^/]+/[^/]+)/pull/([0-9]+) ]]; then
  REPO="${BASH_REMATCH[1]}"
  PR="${BASH_REMATCH[2]}"
fi
if [[ -z "$REPO" ]]; then REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner); fi
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then echo "ERROR: PR must be a number or URL" >&2; exit 1; fi
OWNER="${REPO%%/*}"
REPO_NAME="${REPO#*/}"
ROSTER_CACHE="${PR_MONITOR_STATE_DIRECTORY:-}/authors.state"
ROSTER_POLICY=$(jq -cn --arg repo "$REPO" --arg org "$EMPLOYEE_ORG" --arg file "$AUTHOR_ALLOWLIST_FILE" --argjson non_employees "$INCLUDE_NON_EMPLOYEES" '{repo:$repo,org:$org,file:$file,non_employees:$non_employees}')
if [[ "$ONCE" == "1" && -f "$ROSTER_CACHE" && "${PR_MONITOR_REFRESH_ROSTER:-0}" != "1" ]]; then
  [[ "$(jq -c '.policy' "$ROSTER_CACHE")" == "$ROSTER_POLICY" ]] || exit 1
  jq -e '.authors | type == "string"' "$ROSTER_CACHE" >/dev/null || exit 1
  ALLOWED_AUTHORS=$(jq -r '.authors' "$ROSTER_CACHE")
  AUTHOR_ALLOWLIST_ENABLED=$(jq -r '.enabled' "$ROSTER_CACHE")
  CURRENT_GITHUB_USER=$(jq -r '.user' "$ROSTER_CACHE")
  [[ "$AUTHOR_ALLOWLIST_ENABLED" =~ ^[01]$ && -n "$CURRENT_GITHUB_USER" ]] || exit 1
else
# Deny comment delivery unless the owner has a policy or an explicit roster.
if [[ "$INCLUDE_NON_EMPLOYEES" != "1" ]]; then
  AUTHOR_ALLOWLIST_ENABLED=1
  if [[ -n "$AUTHOR_ALLOWLIST_FILE" ]]; then
    [[ -r "$AUTHOR_ALLOWLIST_FILE" ]] || { echo "ERROR: cannot read author whitelist: $AUTHOR_ALLOWLIST_FILE" >&2; exit 1; }
    ALLOWED_AUTHORS=$(awk '{ sub(/#.*/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if (length) print }' "$AUTHOR_ALLOWLIST_FILE")
    AUTHOR_ALLOWLIST_ENABLED=1
  else
    if [[ -z "$EMPLOYEE_ORG" && " $TRUSTED_ORGS " == *" $OWNER "* ]]; then
      EMPLOYEE_ORG="$OWNER"
    fi
    if [[ -n "$EMPLOYEE_ORG" ]]; then
      if ! ALLOWED_AUTHORS=$(gh api "orgs/$EMPLOYEE_ORG/members" --paginate --jq '.[].login'); then
        echo "ERROR: cannot load employee whitelist for $EMPLOYEE_ORG; no monitor started" >&2
        exit 1
      fi
      [[ -n "$ALLOWED_AUTHORS" ]] || { echo "ERROR: employee whitelist for $EMPLOYEE_ORG is empty; no monitor started" >&2; exit 1; }
      if [[ " $TRUSTED_ORGS " == *" $OWNER "* && -n "$TRUSTED_BOTS" ]]; then
        # Exact GitHub App logins, not a blanket exemption for bots.
        ALLOWED_AUTHORS+=$'\n'"$TRUSTED_BOTS"
      fi
      AUTHOR_ALLOWLIST_ENABLED=1
    fi
  fi
fi
CURRENT_GITHUB_USER="$(gh api user --jq .login 2>/dev/null || true)"
if [[ "$INCLUDE_SELF_COMMENTS" != "1" && -z "$CURRENT_GITHUB_USER" ]]; then
  echo "ERROR: could not identify the authenticated GitHub user; use --include-self-comments to opt out of self filtering" >&2
  exit 1
fi

fi
if [[ "$ONCE" == "1" && -n "${PR_MONITOR_STATE_DIRECTORY:-}" ]]; then
  mkdir -p "$PR_MONITOR_STATE_DIRECTORY"
  jq -cn --argjson policy "$ROSTER_POLICY" --arg authors "$ALLOWED_AUTHORS" --arg user "$CURRENT_GITHUB_USER" --argjson enabled "$AUTHOR_ALLOWLIST_ENABLED" '{policy:$policy,authors:$authors,user:$user,enabled:$enabled}' > "$ROSTER_CACHE"
fi

# Default state belongs to this producer, not every watcher of the same PR.
# Explicit state directories support --once callers that persist their snapshots.
if [[ -n "${PR_MONITOR_STATE_DIRECTORY:-}" ]]; then
  STATE_DIR="$PR_MONITOR_STATE_DIRECTORY"
  mkdir -p "$STATE_DIR"
else
  STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pr-monitor-${REPO//\//-}-${PR}.XXXXXX")
  trap 'rm -rf "$STATE_DIR"' EXIT
fi
CI_EVENT_POLICY="${MONITOR_PR_CI_POLICY:-$SCRIPT_DIR/policies/ci-event-policy.py}"
COMMENT_AUTHOR_POLICY="${MONITOR_PR_AUTHOR_POLICY:-$SCRIPT_DIR/policies/comment-author-policy.sh}"
PYTHON3="${MONITOR_PR_PYTHON_BIN:-$(command -v python3 2>/dev/null || true)}"
[[ -x "$PYTHON3" ]] || { echo "ERROR: python3 is required" >&2; exit 1; }
[[ -x "$CI_EVENT_POLICY" ]] || { echo "ERROR: CI event policy helper not executable: $CI_EVENT_POLICY" >&2; exit 1; }
[[ -f "$COMMENT_AUTHOR_POLICY" ]] || { echo "ERROR: comment author policy helper not found: $COMMENT_AUTHOR_POLICY" >&2; exit 1; }
# shellcheck disable=SC1090
source "$COMMENT_AUTHOR_POLICY"

# Detached monitors can inherit TZ=UTC from a parent agent. Resolve the Mac's
# configured timezone so event timestamps are always local to the user.
LOCAL_TZ="${MONITOR_PR_TIMEZONE:-$(readlink /etc/localtime 2>/dev/null | sed 's#^.*/zoneinfo/##')}"
timestamp() {
  if [[ -n "$LOCAL_TZ" ]]; then
    TZ="$LOCAL_TZ" date '+%Y-%m-%d %H:%M:%S %z'
  else
    env -u TZ date '+%Y-%m-%d %H:%M:%S %z'
  fi
}

emit() {
  printf '%s\n\n' "$*"
}

decode_body() {
  local encoded="${1#b64:}"
  printf '%s' "$encoded" | base64 --decode
}

quote_body() {
  decode_body "$1" | awk '{ sub(/[ \t\r]+$/, ""); print "> " $0 }'
}

emit_comment() {
  local kind="$1" author="**${2:-unknown}**" context="$3" encoded_body="$4" url="$5" header
  case "$kind" in
    review)
      case "$context" in
        APPROVED) header="✅ $author approved" ;;
        CHANGES_REQUESTED) header="🔴 $author requested changes" ;;
        *) header="💬 $author reviewed" ;;
      esac
      ;;
    review-comment) header="💬 $author commented on \`$context\`" ;;
    *) header="💬 $author commented" ;;
  esac
  printf '%s · [view](%s)\n' "$header" "$url"
  quote_body "$encoded_body"
  printf '\n'
}

emit_unresolved() {
  local path="$1" line="$2" author="$3" encoded_body="$4" url="$5"
  printf '💬 **%s** has an unresolved thread on `%s:%s` · [view](%s)\n' "${author:-unknown}" "${path:-?}" "${line:-?}" "$url"
  quote_body "$encoded_body"
  printf '\n'
}

visible_unresolved_count() {
  local file="$1" count=0 kind id path line author encoded_body url
  while IFS=$'\t' read -r kind id path line author encoded_body url; do
    [[ -n "${kind:-}" ]] || continue
    if ! comment_author_is_ignored "$author" "$CURRENT_GITHUB_USER" "$INCLUDE_SELF_COMMENTS" "$IGNORE_AUTHORS"; then
      count=$((count + 1))
    fi
  done < "$file"
  printf '%s\n' "$count"
}

visible_comment_count() {
  local file="$1" count=0 kind id updated author context encoded_body url
  while IFS=$'\t' read -r kind id updated author context encoded_body url; do
    [[ -n "${kind:-}" ]] || continue
    if ! comment_author_is_ignored "$author" "$CURRENT_GITHUB_USER" "$INCLUDE_SELF_COMMENTS" "$IGNORE_AUTHORS"; then
      count=$((count + 1))
    fi
  done < "$file"
  printf '%s\n' "$count"
}

new_comment_records() {
  local previous="$1" current="$2"
  awk -F '\t' -v previous="$previous" '
    function identity() { return $1 FS $2 FS $3 FS $6 }
    FILENAME == previous { seen[identity()] = 1; next }
    !seen[identity()] { print }
  ' "$previous" "$current"
}

comment_is_security_review_status() {
  local kind="$1" encoded_body="$2"
  [[ "$kind" == "issue-comment" ]] || return 1
  decode_body "$encoded_body" | grep -Fq '<!-- codex-security-review-stale -->'
}

defer_comment_key() {
  local kind="$1" id="$2" file="$3" next="$3.next"
  { cat "$file" 2>/dev/null || true; printf '%s\t%s\n' "$kind" "$id"; } | sort -u > "$next"
  mv "$next" "$file"
}

forget_deferred_comment_key() {
  local kind="$1" id="$2" file="$3" next="$3.next"
  awk -F '\t' -v kind="$kind" -v id="$id" '!($1 == kind && $2 == id)' "$file" > "$next"
  mv "$next" "$file"
}

current_deferred_comment_records() {
  local keys="$1" comments="$2"
  awk -F '\t' -v keys="$keys" '
    FILENAME == keys { wanted[$1 FS $2] = 1; next }
    wanted[$1 FS $2] { print }
  ' "$keys" "$comments"
}

comment_snapshot_is_valid() {
  local file="$1"
  awk -F '\t' '
    NF != 7 { exit 1 }
    $1 !~ /^(issue-comment|review-comment|review)$/ { exit 1 }
    $2 == "" || $3 == "" || $4 == "" { exit 1 }
    $6 !~ /^b64:/ { exit 1 }
    $7 !~ /^https?:\/\// { exit 1 }
  ' "$file"
}

fetch_comment_endpoint() {
  local endpoint="$1" filter="$2" output="$3" attempt
  for ((attempt = 1; attempt <= COMMENT_FETCH_ATTEMPTS; attempt++)); do
    if gh api --paginate "$endpoint" \
      --jq ".[] | select(type == \"object\") | select(.id != null and .user.login != null and .html_url != null) | $filter" \
      >"$output" 2>/dev/null && comment_snapshot_is_valid "$output"; then
      return 0
    fi
    (( attempt < COMMENT_FETCH_ATTEMPTS )) && sleep "$COMMENT_FETCH_RETRY_DELAY"
  done
  return 1
}

snapshot_comments() {
  # A failed endpoint must fail the whole snapshot. Keeping the previous state
  # avoids treating an API error body as a comment or replaying every comment
  # after a transient partial response.
  local output_dir issue_tmp review_comment_tmp review_tmp
  output_dir=$(mktemp -d "$STATE_DIR/comments-fetch.XXXXXX")
  issue_tmp="$output_dir/issues"
  review_comment_tmp="$output_dir/review-comments"
  review_tmp="$output_dir/reviews"

  if ! fetch_comment_endpoint \
    "repos/$REPO/issues/$PR/comments?per_page=100" \
    '["issue-comment", .id, .updated_at, .user.login, "-", ("b64:" + ((.body // "") | @base64)), .html_url] | @tsv' \
    "$issue_tmp" || \
    ! fetch_comment_endpoint \
    "repos/$REPO/pulls/$PR/comments?per_page=100" \
    '["review-comment", .id, .updated_at, .user.login, "\(.path // "?"):\(.line // .original_line // "?")", ("b64:" + ((.body // "") | @base64)), .html_url] | @tsv' \
    "$review_comment_tmp" || \
    ! fetch_comment_endpoint \
    "repos/$REPO/pulls/$PR/reviews?per_page=100" \
    '["review", .id, (.submitted_at // .updated_at), .user.login, (.state // "UNKNOWN"), ("b64:" + ((.body // "") | @base64)), .html_url] | @tsv' \
    "$review_tmp"; then
    rm -rf "$output_dir"
    return 1
  fi

  # Bodies are base64-encoded only in the state snapshot so each event remains
  # one sortable record. They are decoded with their original formatting when
  # emitted to the monitor transport.
  cat "$issue_tmp" "$review_comment_tmp" "$review_tmp" | sort
  rm -rf "$output_dir"
}

snapshot_checks() {
  local checks_json
  if ! checks_json=$(gh pr checks "$PR" --repo "$REPO" --json name,bucket,state,link 2>/dev/null); then
    printf 'checks\tunknown\tgh-pr-checks-failed\n'
    return
  fi

  printf '%s' "$checks_json" \
    | jq -r '.[] | ["check", .name, (.bucket // "unknown"), (.state // "unknown"), (.state // "unknown"), (.link // "")] | @tsv' \
    | sort
}

snapshot_unresolved_threads() {
  gh api graphql -f owner="$OWNER" -f name="$REPO_NAME" -F number="$PR" -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(last: 1) {
                nodes {
                  author { login }
                  bodyText
                  url
                }
              }
            }
          }
        }
      }
    }' 2>/dev/null \
    | jq -r '
      .data.repository.pullRequest.reviewThreads.nodes[]?
      | select(.isResolved == false)
      | .comments.nodes[0] as $c
      | ["unresolved", .id, .path, (.line // "?"), ($c.author.login // "unknown"), ("b64:" + (($c.bodyText // "") | @base64)), ($c.url // "")]
      | @tsv
    ' \
    | sort || true
}

summarize_checks() {
  awk -F '\t' '$1 == "check" { n[$3]++ } END {
    split("pass passed fail failed cancel cancelled pending pending skipping skipped", w, " ")
    for (i = 1; i < 10; i += 2) if (w[i] in n) { out = out sep n[w[i]] " " w[i + 1]; sep = ", "; delete n[w[i]] }
    for (b in n) { out = out sep n[b] " " b; sep = ", " }
    print (out == "" ? "no checks" : out)
  }' "$1"
}

check_item() {
  local name="$1" bucket="$2" link="$3" icon status
  case "$bucket" in
    fail) icon="❌" status="failed" ;;
    cancel) icon="⛔" status="cancelled" ;;
    pending) icon="⏳" status="pending" ;;
    *) icon="❔" status="$bucket" ;;
  esac
  printf -- '- %s `%s` %s' "$icon" "$name" "$status"
  if [[ -n "$link" ]]; then printf ' · [details](%s)' "$link"; fi
  printf '\n'
}

# Checks in the given buckets, as Markdown list items.
checks_in() {
  local checks_file="$1" buckets="$2"
  while IFS=$'\t' read -r kind name bucket state conclusion link; do
    [[ "$kind" == "check" && " $buckets " == *" $bucket "* ]] && check_item "$name" "$bucket" "$link"
  done < "$checks_file"
  return 0
}

new_failing_checks() {
  local previous="$1" current="$2"
  awk -F '\t' '
    function identity() { return $2 FS $3 FS $4 }
    FILENAME == ARGV[1] {
      if ($1 == "check" && $3 ~ /^(fail|cancel)$/) seen[identity()] = 1
      next
    }
    $1 == "check" && $3 ~ /^(fail|cancel)$/ && !seen[identity()] { print }
  ' "$previous" "$current" | while IFS=$'\t' read -r kind name bucket state conclusion link; do
    check_item "$name" "$bucket" "$link"
  done
}

# A heading followed by list items read from stdin, as one Markdown block.
emit_list() {
  local items
  items=$(cat)
  if [[ -n "$items" ]]; then printf '%s\n%s\n\n' "$1" "$items"; else emit "$1"; fi
}

snapshot_pr_state() {
  gh api graphql -f owner="$OWNER" -f name="$REPO_NAME" -F number="$PR" -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          state
          mergeStateStatus
          reviewDecision
          isDraft
          autoMergeRequest { enabledAt }
          url
          title
          isInMergeQueue
          mergeQueueEntry {
            position
            state
            estimatedTimeToMerge
            enqueuedAt
          }
        }
      }
    }' \
    --jq '.data.repository.pullRequest | [.state, (.mergeStateStatus // "UNKNOWN"), (.reviewDecision // "UNKNOWN"), (if .isDraft then "draft" else "ready" end), (if .autoMergeRequest then "auto-merge" else "manual-merge" end), .url, (.title | gsub("[\r\n\t]+"; " ")), (.isInMergeQueue // false), (.mergeQueueEntry.position // ""), (.mergeQueueEntry.state // ""), (.mergeQueueEntry.estimatedTimeToMerge // ""), (.mergeQueueEntry.enqueuedAt // "")] | @tsv' \
    2>/dev/null || return 1
}

format_eta() {
  local seconds="$1"
  if [[ -z "$seconds" || ! "$seconds" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if (( seconds >= 3600 )); then
    printf ', eta %dh%02dm' $((seconds / 3600)) $(((seconds % 3600) / 60))
  elif (( seconds >= 60 )); then
    printf ', eta %dm' $((seconds / 60))
  else
    printf ', eta %ds' "$seconds"
  fi
}

format_pr_state() {
  local state merge_state review_decision draft_state merge_mode url title in_queue queue_position queue_state queue_eta queue_enqueued
  IFS=$'\t' read -r state merge_state review_decision draft_state merge_mode url title in_queue queue_position queue_state queue_eta queue_enqueued < "$1"
  local parts=("$(tr '[:upper:]' '[:lower:]' <<<"${state:-unknown}")" "${draft_state:-unknown}")
  case "$review_decision" in
    APPROVED) parts+=("approved") ;;
    CHANGES_REQUESTED) parts+=("changes requested") ;;
    REVIEW_REQUIRED) parts+=("review required") ;;
  esac
  case "$merge_state" in
    CLEAN) parts+=("mergeable") ;;
    DIRTY) parts+=("conflicting") ;;
    BEHIND) parts+=("behind base") ;;
    BLOCKED) parts+=("blocked") ;;
    UNSTABLE) parts+=("unstable") ;;
  esac
  if [[ "${in_queue:-false}" == "true" ]]; then
    parts+=("merge queue position ${queue_position:-?}$(format_eta "${queue_eta:-}")")
  elif [[ "$merge_mode" == "auto-merge" ]]; then
    parts+=("auto-merge on")
  fi
  printf '%s' "${parts[0]}"
  printf ' · %s' "${parts[@]:1}"
}

pr_change_is_non_actionable() {
  local old_state old_merge old_review old_draft old_mode old_url old_title old_in_queue old_queue_position old_queue_state old_queue_eta old_queue_enqueued
  local new_state new_merge new_review new_draft new_mode new_url new_title new_in_queue new_queue_position new_queue_state new_queue_eta new_queue_enqueued
  IFS=$'\t' read -r old_state old_merge old_review old_draft old_mode old_url old_title old_in_queue old_queue_position old_queue_state old_queue_eta old_queue_enqueued < "$1"
  IFS=$'\t' read -r new_state new_merge new_review new_draft new_mode new_url new_title new_in_queue new_queue_position new_queue_state new_queue_eta new_queue_enqueued < "$2"

  [[ "$old_state" == "$new_state" ]] || return 1
  [[ "$old_review" == "$new_review" ]] || return 1
  # Draft/readiness is controlled by the author and does not create review,
  # CI, or merge work by itself. Consume it into the snapshot without waking
  # the owning task.
  [[ "$old_mode" == "$new_mode" ]] || return 1
  [[ "$old_url" == "$new_url" ]] || return 1
  [[ "$old_title" == "$new_title" ]] || return 1
  [[ "$old_in_queue" == "$new_in_queue" ]] || return 1

  # Merge-queue position/state/eta/enqueued churn while the PR stays in the queue is
  # just the queue advancing (position 4->3, AWAITING_CHECKS<->QUEUED, eta ticking
  # down). Per-interval, that's pure noise — only entering/leaving the queue
  # (old_in_queue != new_in_queue, checked above) or a terminal state is worth a
  # notification. So queue_position/queue_state/queue_eta/queue_enqueued are ignored.

  # Mergeability is derived from checks, reviews, queue state, and GitHub's
  # asynchronous recomputation. Those sources already emit their own events,
  # so CLEAN/BLOCKED/UNSTABLE/UNKNOWN churn is redundant. Only a newly
  # conflicting head is independently actionable here, but only once the PR
  # is ready for review. Draft conflicts can wait until the author makes the
  # PR reviewable.
  [[ "$new_draft" == "ready" && "$old_merge" != "DIRTY" && "$new_merge" == "DIRTY" ]] && return 1
  return 0
}

pr_change_is_explained_by_submitted_review() {
  local old_state old_merge old_review old_draft old_mode old_url old_title old_in_queue old_queue_position old_queue_state old_queue_eta old_queue_enqueued
  local new_state new_merge new_review new_draft new_mode new_url new_title new_in_queue new_queue_position new_queue_state new_queue_eta new_queue_enqueued
  IFS=$'\t' read -r old_state old_merge old_review old_draft old_mode old_url old_title old_in_queue old_queue_position old_queue_state old_queue_eta old_queue_enqueued < "$1"
  IFS=$'\t' read -r new_state new_merge new_review new_draft new_mode new_url new_title new_in_queue new_queue_position new_queue_state new_queue_eta new_queue_enqueued < "$2"

  [[ "$old_state" == "$new_state" ]] || return 1
  [[ "$old_review" != "$new_review" ]] || return 1
  [[ "$old_mode" == "$new_mode" ]] || return 1
  [[ "$old_url" == "$new_url" ]] || return 1
  [[ "$old_title" == "$new_title" ]] || return 1
  [[ "$old_in_queue" == "$new_in_queue" ]] || return 1
  [[ "$new_draft" == "ready" && "$old_merge" != "DIRTY" && "$new_merge" == "DIRTY" ]] && return 1
  return 0
}

first=1
if [[ "$ONCE" == "1" && -s "$STATE_DIR/pr.state" && -f "$STATE_DIR/comments.state" && -f "$STATE_DIR/checks.state" ]]; then first=0; fi
comment_fetch_failures=0
comment_health_degraded=0
if [[ "$ONCE" == "1" && -f "$STATE_DIR/health.state" ]]; then
  read -r comment_fetch_failures comment_health_degraded < "$STATE_DIR/health.state"
  [[ "$comment_fetch_failures" =~ ^[0-9]+$ && "$comment_health_degraded" =~ ^[01]$ ]] || exit 1
fi
deferred_comments_state="$STATE_DIR/deferred-comments.state"
touch "$deferred_comments_state"
while true; do
  pr_tmp="$STATE_DIR/pr.next"
  comments_tmp="$STATE_DIR/comments.next"
  checks_tmp="$STATE_DIR/checks.next"
  pr_state="$STATE_DIR/pr.state"
  comments_state="$STATE_DIR/comments.state"
  checks_state="$STATE_DIR/checks.state"

  if ! snapshot_pr_state > "$pr_tmp"; then
    [[ "$ONCE" == "1" ]] && exit 1
    if [[ "$first" == "1" ]]; then
      emit "⚠️ Couldn't fetch PR #$PR in $REPO; retrying"
    fi
    sleep "$INTERVAL"
    continue
  fi
  comments_available=1
  if ! snapshot_comments > "$comments_tmp"; then
    [[ "$ONCE" == "1" && "$first" == "1" ]] && exit 1
    comments_available=0
    rm -f "$comments_tmp"
    comment_fetch_failures=$((comment_fetch_failures + 1))
    if (( comment_fetch_failures >= COMMENT_HEALTH_FAILURE_THRESHOLD && comment_health_degraded == 0 )); then
      emit "⚠️ Comment polling degraded after $comment_fetch_failures consecutive failures; retrying without advancing comment state"
      comment_health_degraded=1
    fi
  else
    if (( comment_health_degraded == 1 )); then
      emit "✅ Comment polling recovered"
    fi
    comment_fetch_failures=0
    comment_health_degraded=0
  fi
  snapshot_checks > "$checks_tmp"

  current_state=$(cut -f1 "$pr_tmp")
  current_draft_state=$(cut -f4 "$pr_tmp")
  if [[ "$first" == "1" ]]; then
    unresolved_tmp="$STATE_DIR/unresolved.initial"
    snapshot_unresolved_threads > "$unresolved_tmp"
    unresolved_count=$(visible_unresolved_count "$unresolved_tmp")
    if [[ "$comments_available" == "1" ]]; then
      initial_comment_count=$(visible_comment_count "$comments_tmp")
    else
      initial_comment_count="unknown"
    fi
    initial_summary="PR #$PR in $REPO: $(format_pr_state "$pr_tmp") · $initial_comment_count comments · $unresolved_count unresolved · checks: $(summarize_checks "$checks_tmp")"
    if [[ "$QUIET_INITIAL" == "1" ]]; then
      printf '[%s] %s\n' "$(timestamp)" "$initial_summary" >&2
      failing=$(checks_in "$checks_tmp" "fail cancel")
      if [[ -n "$failing" ]]; then emit_list "🔴 Failing checks" <<<"$failing"; fi
    else
      checks_in "$checks_tmp" "fail cancel pending" | emit_list "$initial_summary"
    fi
    if [[ "$comments_available" == "1" ]]; then
      while IFS=$'\t' read -r kind id updated author context encoded_body url; do
        [[ -n "${kind:-}" ]] || continue
        if comment_author_is_ignored "$author" "$CURRENT_GITHUB_USER" "$INCLUDE_SELF_COMMENTS" "$IGNORE_AUTHORS"; then continue; fi
        if comment_is_security_review_status "$kind" "$encoded_body"; then
          if [[ "$current_draft_state" == "draft" ]]; then
            defer_comment_key "$kind" "$id" "$deferred_comments_state"
          else
            emit_comment "$kind" "$author" "$context" "$encoded_body" "$url"
          fi
        fi
      done < "$comments_tmp"
    fi
    while IFS=$'\t' read -r kind id path line author encoded_body url; do
      [[ -n "${kind:-}" ]] || continue
      if comment_author_is_ignored "$author" "$CURRENT_GITHUB_USER" "$INCLUDE_SELF_COMMENTS" "$IGNORE_AUTHORS"; then continue; fi
      emit_unresolved "$path" "$line" "$author" "$encoded_body" "$url"
    done < "$unresolved_tmp"
  else
    submitted_review_explains_decision=0
    if [[ "$comments_available" == "1" ]] && ! cmp -s "$comments_state" "$comments_tmp"; then
      comments_delta="$STATE_DIR/comments.delta"
      new_comment_records "$comments_state" "$comments_tmp" > "$comments_delta"
      new_review_decision=$(cut -f3 "$pr_tmp")
      while IFS=$'\t' read -r kind id updated author context encoded_body url; do
        [[ -z "${kind:-}" ]] && continue
        if comment_author_is_ignored "$author" "$CURRENT_GITHUB_USER" "$INCLUDE_SELF_COMMENTS" "$IGNORE_AUTHORS"; then continue; fi
        if comment_is_security_review_status "$kind" "$encoded_body"; then
          if [[ "$current_draft_state" == "draft" ]]; then
            defer_comment_key "$kind" "$id" "$deferred_comments_state"
            continue
          fi
          forget_deferred_comment_key "$kind" "$id" "$deferred_comments_state"
        fi
        emit_comment "$kind" "$author" "$context" "$encoded_body" "$url"
        if [[ "$kind" == "review" && "$context" == "$new_review_decision" ]]; then
          submitted_review_explains_decision=1
        fi
      done < "$comments_delta"
    fi
    if [[ "$comments_available" == "1" && "$current_draft_state" == "ready" && -s "$deferred_comments_state" ]]; then
      while IFS=$'\t' read -r kind id updated author context encoded_body url; do
        [[ -n "${kind:-}" ]] || continue
        if comment_author_is_ignored "$author" "$CURRENT_GITHUB_USER" "$INCLUDE_SELF_COMMENTS" "$IGNORE_AUTHORS"; then continue; fi
        emit_comment "$kind" "$author" "$context" "$encoded_body" "$url"
      done < <(current_deferred_comment_records "$deferred_comments_state" "$comments_tmp")
      : > "$deferred_comments_state"
    fi
    if ! cmp -s "$pr_state" "$pr_tmp"; then
      if [[ "$current_state" != "MERGED" && "$current_state" != "CLOSED" ]] && \
        ! pr_change_is_non_actionable "$pr_state" "$pr_tmp"; then
        if [[ "$submitted_review_explains_decision" != "1" ]] || \
          ! pr_change_is_explained_by_submitted_review "$pr_state" "$pr_tmp"; then
          emit "🔀 PR is now $(format_pr_state "$pr_tmp")"
        fi
      fi
    fi
    if ! cmp -s "$checks_state" "$checks_tmp"; then
      review_decision=$(cut -f3 "$pr_tmp")
      draft_state=$(cut -f4 "$pr_tmp")
      ci_decision=$($PYTHON3 "$CI_EVENT_POLICY" \
        --draft-state "$draft_state" \
        --review-decision "$review_decision" \
        "$checks_state" "$checks_tmp")
      if [[ "$(jq -r '.emit' <<<"$ci_decision")" == "true" ]]; then
        icon="🟢"
        if [[ -n "$(checks_in "$checks_tmp" "fail cancel")" ]]; then icon="🔴"; fi
        heading="$icon CI: $(jq -r '.reason' <<<"$ci_decision") ($(summarize_checks "$checks_tmp"))"
        if [[ "$(jq -r '.kind' <<<"$ci_decision")" == "failure" ]]; then
          new_failing_checks "$checks_state" "$checks_tmp" | emit_list "$heading"
        else
          checks_in "$checks_tmp" "fail cancel" | emit_list "$heading"
        fi
      fi
    fi
  fi

  mv "$pr_tmp" "$pr_state"
  if [[ "$comments_available" == "1" ]]; then
    mv "$comments_tmp" "$comments_state"
  fi
  mv "$checks_tmp" "$checks_state"

  terminal_state=0
  if [[ "$first" == "1" ]]; then
    case "$current_state" in
      MERGED) emit "🟣 PR #$PR merged"; terminal_state=1 ;;
      CLOSED) emit "⛔ PR #$PR closed"; terminal_state=1 ;;
    esac
  elif ! cmp -s "$pr_state.prev" "$pr_state" 2>/dev/null; then
    case "$current_state" in
      MERGED) emit "🟣 PR #$PR merged"; terminal_state=1 ;;
      CLOSED) emit "⛔ PR #$PR closed"; terminal_state=1 ;;
    esac
  fi
  cp "$pr_state" "$pr_state.prev"
  printf '%s %s\n' "$comment_fetch_failures" "$comment_health_degraded" > "$STATE_DIR/health.state"
  if [[ "$terminal_state" == "1" ]]; then
    exit 0
  fi

  [[ "$ONCE" == "1" ]] && exit 0
  first=0
  sleep "$INTERVAL"
done
