#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
monitor="$script_dir/pr-monitor.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin" "$temp_dir/state"

cat >"$temp_dir/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
tick_file="$FAKE_TICK"
tick=0
[[ -f "$tick_file" ]] && tick=$(cat "$tick_file")

if [[ "$args" == "api user --jq .login" ]]; then
  echo test-user
elif [[ ( "$args" == "api orgs/employees/members --paginate --jq .[].login" || "$args" == "api orgs/squareup/members --paginate --jq .[].login" ) ]]; then
  [[ "${FAKE_ROSTER_FAILURE:-0}" != "1" ]] || exit 1
  printf 'reviewer\ntest-user\n'
elif [[ "$args" == *"mergeQueueEntry"* ]]; then
  tick=$((tick + 1))
  echo "$tick" >"$tick_file"
  state=OPEN
  merge_state=CLEAN
  draft_state=ready
  review_decision=REVIEW_REQUIRED
  if [[ "$tick" -eq 2 ]]; then
    draft_state=draft
    merge_state=DIRTY
  fi
  [[ "$tick" -ge 3 ]] && review_decision=APPROVED
  [[ "$tick" -ge 4 ]] && state=CLOSED
  printf '%s\t%s\t%s\t%s\tmanual-merge\thttps://example.test/pr/1\tTest PR\tfalse\t\t\t\t\n' "$state" "$merge_state" "$review_decision" "$draft_state"
elif [[ "$args" == *"reviewThreads(first: 100)"* ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
 {"id":"self-thread","isResolved":false,"path":"self.ts","line":1,"comments":{"nodes":[{"author":{"login":"test-user"},"bodyText":"self task","url":"https://example/self"}]}},
 {"id":"other-thread","isResolved":false,"path":"other.ts","line":2,"comments":{"nodes":[{"author":{"login":"reviewer"},"bodyText":"external task","url":"https://example/other"}]}}
]}}}}}
JSON
elif [[ "$args" == *"issues/1/comments"* ]]; then
  if [[ "$tick" -eq 1 ]]; then
    printf 'issue-comment\t10\t2026-01-01T00:00:00Z\ttest-user\t-\tb64:c2VsZiBpbml0aWFs\thttps://example/self-issue\n'
  elif [[ "$tick" -eq 2 ]]; then
    printf 'issue-comment\t10\t2026-01-01T00:01:00Z\ttest-user\t-\tb64:c2VsZiBlZGl0ZWQ=\thttps://example/self-issue\n'
  else
    printf 'issue-comment\t10\t2026-01-01T00:01:00Z\ttest-user\t-\tb64:c2VsZiBlZGl0ZWQ=\thttps://example/self-issue\n'
    printf 'issue-comment\t11\t2026-01-01T00:02:00Z\treviewer\t-\tb64:ZXh0ZXJuYWwgZmVlZGJhY2s=\thttps://example/external\n'
  fi
elif [[ "$args" == *"pulls/1/comments"* ]]; then
  context="file.ts:4"
  [[ "$tick" -ge 2 ]] && context="file.ts:9"
  printf 'review-comment\t21\t2026-01-01T00:00:00Z\treviewer\t%s\tb64:c3RhYmxlIGV4dGVybmFsIHJldmlldyBjb21tZW50\thttps://example/remapped-review-comment\n' "$context"
  if [[ "$tick" -ge 2 ]]; then
    printf 'review-comment\t20\t2026-01-01T00:01:00Z\ttest-user\tfile.ts:3\tb64:c2VsZiByZXBseQ==\thttps://example/self-review-comment\n'
  fi
elif [[ "$args" == *"pulls/1/reviews"* ]]; then
  if [[ "$tick" -ge 2 ]]; then
    printf 'review\t30\t2026-01-01T00:01:00Z\ttest-user\tCOMMENTED\tb64:c2VsZiByZXZpZXc=\thttps://example/self-review\n'
  fi
  if [[ "$tick" -ge 3 ]]; then
    printf 'review\t31\t2026-01-01T00:02:00Z\treviewer\tAPPROVED\tb64:YXBwcm92ZWQ=\thttps://example/external-review\n'
  fi
elif [[ "$args" == "pr checks "* ]]; then
  printf '[]\n'
else
  echo "unexpected gh invocation: $args" >&2
  exit 1
fi
SH
chmod +x "$temp_dir/bin/gh"

PATH="$temp_dir/bin:$PATH" \
FAKE_TICK="$temp_dir/tick" \
TMPDIR="$temp_dir/state" PR_MONITOR_STATE_DIRECTORY="$temp_dir/state/pr-monitor-owner-repo-1" \
MONITOR_PR_PYTHON_BIN="$(command -v python3)" \
  "$monitor" --repo owner/repo --include-non-employees --interval 0.01 1 >"$temp_dir/default.out"

grep -q '1 comments · 1 unresolved' "$temp_dir/default.out"
grep -q 'external feedback' "$temp_dir/default.out"
grep -q '\*\*reviewer\*\* \(reviewed\|approved\|requested changes\) ·' "$temp_dir/default.out"
[[ "$(grep -c 'PR is now' "$temp_dir/default.out" || true)" -eq 0 ]]
! grep -q 'self initial\|self edited\|self reply\|self review\|self task' "$temp_dir/default.out"
! grep -q 'stable external review comment' "$temp_dir/default.out"
# The self edit was consumed into state before the external event arrived.
grep -q $'issue-comment\t10\t2026-01-01T00:01:00Z' "$temp_dir/state/pr-monitor-owner-repo-1/comments.state"

rm -rf "$temp_dir/state" "$temp_dir/tick"
mkdir -p "$temp_dir/state"
PATH="$temp_dir/bin:$PATH" \
FAKE_TICK="$temp_dir/tick" \
TMPDIR="$temp_dir/state" PR_MONITOR_STATE_DIRECTORY="$temp_dir/state/pr-monitor-owner-repo-1" \
MONITOR_PR_PYTHON_BIN="$(command -v python3)" \
  "$monitor" --repo owner/repo --include-non-employees --interval 0.01 --include-self-comments 1 >"$temp_dir/include.out"

grep -q '2 comments · 2 unresolved' "$temp_dir/include.out"
grep -q 'self edited' "$temp_dir/include.out"
grep -q 'self reply' "$temp_dir/include.out"
grep -q 'self review' "$temp_dir/include.out"
grep -q 'external feedback' "$temp_dir/include.out"
grep -q '\*\*reviewer\*\* \(reviewed\|approved\|requested changes\) ·' "$temp_dir/include.out"
! grep -q 'stable external review comment' "$temp_dir/include.out"
[[ "$(grep -c 'PR is now' "$temp_dir/include.out" || true)" -eq 0 ]]

echo "pr-monitor self-comment tests passed"

# Denied authors are suppressed on every event path but consumed in snapshots.
printf 'unrelated-employee\n' >"$temp_dir/allowlist"
rm -rf "$temp_dir/state" "$temp_dir/tick"
mkdir -p "$temp_dir/state"
PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/tick" TMPDIR="$temp_dir/state" PR_MONITOR_STATE_DIRECTORY="$temp_dir/state/pr-monitor-owner-repo-1" \
  "$monitor" --repo owner/repo --interval 0.01 --allowlist "$temp_dir/allowlist" 1 >"$temp_dir/denied.out"
grep -q '0 comments · 0 unresolved' "$temp_dir/denied.out"
! grep -q '· \[view\]\|external feedback' "$temp_dir/denied.out"
grep -q $'issue-comment\t11' "$temp_dir/state/pr-monitor-owner-repo-1/comments.state"
grep -q 'PR #1 \(merged\|closed\)' "$temp_dir/denied.out"

rm -rf "$temp_dir/state" "$temp_dir/tick"
mkdir -p "$temp_dir/state"
PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/tick" TMPDIR="$temp_dir/state" PR_MONITOR_STATE_DIRECTORY="$temp_dir/state/pr-monitor-owner-repo-1" \
  "$monitor" --repo owner/repo --interval 0.01 --employee-org employees 1 >"$temp_dir/employees.out"
grep -q 'external feedback' "$temp_dir/employees.out"
grep -q '\*\*reviewer\*\* \(reviewed\|approved\|requested changes\) ·' "$temp_dir/employees.out"

if PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/tick" FAKE_ROSTER_FAILURE=1 \
  "$monitor" --repo owner/repo --employee-org employees 1 >"$temp_dir/failed.out" 2>"$temp_dir/failed.err"; then
  echo 'expected organization lookup failure to stop startup' >&2
  exit 1
fi
grep -q 'cannot load employee whitelist' "$temp_dir/failed.err"
[[ ! -s "$temp_dir/failed.out" ]]
# Squareup repositories enable the organization roster without flags.
rm -rf "$temp_dir/state" "$temp_dir/tick"
mkdir -p "$temp_dir/state"
PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/tick" TMPDIR="$temp_dir/state" PR_MONITOR_STATE_DIRECTORY="$temp_dir/state/pr-monitor-owner-repo-1" \
  "$monitor" --repo squareup/repo --interval 0.01 1 >"$temp_dir/squareup.out"
grep -q 'external feedback' "$temp_dir/squareup.out"

# The explicit opt-out bypasses a failing roster lookup.
rm -rf "$temp_dir/state" "$temp_dir/tick"
mkdir -p "$temp_dir/state"
PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/tick" TMPDIR="$temp_dir/state" PR_MONITOR_STATE_DIRECTORY="$temp_dir/state/pr-monitor-owner-repo-1" FAKE_ROSTER_FAILURE=1 \
  "$monitor" --repo squareup/repo --interval 0.01 --include-non-employees 1 >"$temp_dir/opt-out.out"
grep -q 'external feedback' "$temp_dir/opt-out.out"
echo 'pr-monitor employee whitelist tests passed'
