#!/usr/bin/env bash
# Compose monitor-pr's GitHub event stream with policy-filtered base movement.
set -uo pipefail

PR_MONITOR_PID=""
BASE_MONITOR_PID=""
cleanup() {
  [[ -n "$PR_MONITOR_PID" ]] && kill "$PR_MONITOR_PID" 2>/dev/null || true
  [[ -n "$BASE_MONITOR_PID" ]] && kill "$BASE_MONITOR_PID" 2>/dev/null || true
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: monitor-pr-with-base.sh [--repo owner/repo] [--interval secs] [--base-interval secs]
  [--employee-org org] [--allowlist file] [--include-non-employees]
  [--ignore-author login]... [--no-ignore-bots] [--include-self-comments]
  <pr-number-or-url>

Target-branch movement is silent. A conflict, draft or ready, emits once when it starts.
USAGE
}

REPO=""
INTERVAL=60
BASE_INTERVAL=300
INCLUDE_SELF_COMMENTS=0
AUTHOR_FILTER_ARGS=()
PR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --base-interval) BASE_INTERVAL="$2"; shift 2;;
    --employee-org|--allowlist|--ignore-author) AUTHOR_FILTER_ARGS+=("$1" "$2"); shift 2;;
    --include-non-employees|--no-ignore-bots) AUTHOR_FILTER_ARGS+=("$1"); shift;;
    --include-self-comments) INCLUDE_SELF_COMMENTS=1; shift;;
    -h|--help) usage; exit 0;;
    *) [[ -z "$PR" ]] || { echo "ERROR: unexpected argument: $1" >&2; exit 1; }; PR="$1"; shift;;
  esac
done
[[ -n "$PR" ]] || { usage >&2; exit 1; }
if [[ "$PR" =~ github\.com/([^/]+/[^/]+)/pull/([0-9]+) ]]; then
  REPO="${BASH_REMATCH[1]}"
  PR="${BASH_REMATCH[2]}"
fi
if [[ -z "$REPO" ]]; then REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner); fi
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "ERROR: PR must be a number or URL" >&2; exit 1; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PR_MONITOR="$SCRIPT_DIR/pr-monitor.sh"
PR_MONITOR="${MONITOR_PR_PRODUCER:-$PR_MONITOR}"
GH_BIN="${GH_BIN:-gh}"
[[ -x "$PR_MONITOR" ]] || { echo "ERROR: $PR_MONITOR not executable" >&2; exit 1; }


snapshot_mergeable() { "$GH_BIN" pr view "$PR" -R "$REPO" --json mergeable -q .mergeable; }

emit_base_conflict() {
  printf '⚠️ PR #%s conflicts with `%s` at %s%s. Rebase it onto `%s`.\n\n' "$PR" "$BASE_REF" "${BASE_SHA:0:8}" "$1" "$BASE_REF"
}


PR_MONITOR_ARGS=(--repo "$REPO" --interval "$INTERVAL" --quiet-initial --no-conflict-events)
[[ "$INCLUDE_SELF_COMMENTS" == "1" ]] && PR_MONITOR_ARGS+=(--include-self-comments)
"$PR_MONITOR" "${PR_MONITOR_ARGS[@]}" ${AUTHOR_FILTER_ARGS[@]+"${AUTHOR_FILTER_ARGS[@]}"} "$PR" &
PR_MONITOR_PID=$!

# GitHub recomputes mergeability lazily; UNKNOWN keeps the last known state.
(
STARTUP_WARNED=0
while true; do
  if BASE_REF=$("$GH_BIN" pr view "$PR" -R "$REPO" --json baseRefName -q .baseRefName 2>/dev/null) &&
    [[ -n "$BASE_REF" ]] &&
    BASE_SHA=$("$GH_BIN" api "repos/$REPO/branches/$BASE_REF" -q .commit.sha 2>/dev/null) &&
    [[ -n "$BASE_SHA" ]]; then
    break
  fi
  if [[ "$STARTUP_WARNED" == 0 ]]; then
    echo "⚠️ PR #$PR startup lookup failed or returned an empty ref; retrying." >&2
    STARTUP_WARNED=1
  fi
  sleep "$BASE_INTERVAL"
done

CONFLICTING=0
[[ "$(snapshot_mergeable)" == CONFLICTING ]] && { CONFLICTING=1; emit_base_conflict ""; }

  while kill -0 "$PR_MONITOR_PID" 2>/dev/null; do
    sleep "$BASE_INTERVAL"
    kill -0 "$PR_MONITOR_PID" 2>/dev/null || break
    NEW_SHA=$("$GH_BIN" api "repos/$REPO/branches/$BASE_REF" -q .commit.sha 2>/dev/null) || continue
    mergeable=$(snapshot_mergeable 2>/dev/null) || continue
    old_sha="$BASE_SHA"
    [[ -n "$NEW_SHA" ]] && BASE_SHA="$NEW_SHA"
    case "$mergeable" in
      CONFLICTING)
        if [[ "$CONFLICTING" == 0 ]]; then
          detail=""
          [[ "$BASE_SHA" != "$old_sha" ]] && detail=" (base moved ${old_sha:0:8} → ${BASE_SHA:0:8})"
          emit_base_conflict "$detail"
        fi
        CONFLICTING=1 ;;
      MERGEABLE) CONFLICTING=0 ;;
    esac
  done
) &
BASE_MONITOR_PID=$!

wait "$PR_MONITOR_PID"
STATUS=$?
kill "$BASE_MONITOR_PID" 2>/dev/null || true
wait "$BASE_MONITOR_PID" 2>/dev/null || true
exit "$STATUS"
