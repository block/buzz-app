#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../src-tauri/resources/attention/github-pr" && pwd)"
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
elif [[ "$args" == *"mergeQueueEntry"* ]]; then
  tick=$((tick + 1))
  echo "$tick" >"$tick_file"
  state=OPEN
  [[ "$tick" -ge 5 ]] && state=CLOSED
  printf '%s\tCLEAN\tAPPROVED\tready\tmanual-merge\thttps://example.test/pr/1\tTest PR\tfalse\t\t\t\t\n' "$state"
elif [[ "$args" == *"reviewThreads(first: 100)"* ]]; then
  printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
elif [[ "$args" == *"issues/1/comments"* ]]; then
  case "$tick" in
    1)
      if [[ "${FAIL_INITIAL:-0}" == 1 ]]; then exit 1; fi
      printf '%s\n' 'issue-comment	10	2026-01-01T00:00:00Z	reviewer	-	b64:aW5pdGlhbA==	https://example/initial'
      ;;
    2|3)
      # Reproduce gh returning a non-array API error payload with exit 0.
      printf '%s\n' '{"message":"No server is currently available to service your request."}'
      ;;
    *)
      printf '%s\n' 'issue-comment	10	2026-01-01T00:00:00Z	reviewer	-	b64:aW5pdGlhbA==	https://example/initial'
      printf '%s\n' 'issue-comment	11	2026-01-01T00:04:00Z	reviewer	-	b64:cmVjb3ZlcmVkIGZlZWRiYWNr	https://example/recovered'
      ;;
  esac
elif [[ "$args" == *"pulls/1/reviews"* ]]; then
  printf '%s' '[{"id":99,"state":"PENDING","submitted_at":null,"user":{"login":"reviewer"},"body":"draft","html_url":"https://example/draft"}]' | jq -r "${@: -1}"
elif [[ "$args" == *"pulls/1/comments"* ]]; then
  :
elif [[ "$args" == "pr checks "* ]]; then
  printf '[]\n'
else
  echo "unexpected gh invocation: $args" >&2
  exit 1
fi
SH
chmod +x "$temp_dir/bin/gh"

for fail_initial in 0 1; do
rm -f "$temp_dir/tick"
PATH="$temp_dir/bin:$PATH" \
FAIL_INITIAL="$fail_initial" \
FAKE_TICK="$temp_dir/tick" \
TMPDIR="$temp_dir/state" \
MONITOR_PR_PYTHON_BIN="$(command -v python3)" \
PR_MONITOR_COMMENT_FETCH_ATTEMPTS=1 \
PR_MONITOR_COMMENT_FETCH_RETRY_DELAY=0 \
PR_MONITOR_COMMENT_HEALTH_FAILURE_THRESHOLD=2 \
  "$monitor" --repo owner/repo --include-non-employees --interval 0.01 1 >"$temp_dir/out"

! grep -q 'No server is currently available\|by unknown' "$temp_dir/out" || exit 1
grep -q 'Comment polling degraded after 2 consecutive failures' "$temp_dir/out"
grep -q 'Comment polling recovered' "$temp_dir/out"
if [[ "$fail_initial" == 0 ]]; then
  grep -q 'recovered feedback' "$temp_dir/out"
else
  ! grep -q 'recovered feedback' "$temp_dir/out"
fi
grep -q 'PR #1 closed' "$temp_dir/out"
# The initial snapshot survives failed polls, and the recovered snapshot advances state.

done
echo "pr-monitor comment error tests passed"
