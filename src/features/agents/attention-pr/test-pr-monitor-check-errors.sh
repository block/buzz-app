#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
monitor="${PR_MONITOR_SCRIPT:-$script_dir/pr-monitor.sh}"
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
elif [[ "$args" == *"pulls/1/comments"* || "$args" == *"pulls/1/reviews"* ]]; then
  :
elif [[ "$args" == "pr checks "* ]]; then
  if [[ "$tick" == 2 ]]; then exit 1; fi
  bucket="$CHECK_BASELINE"
  [[ "$tick" -ge 4 ]] && bucket=pass
  printf '[{"name":"build","bucket":"%s","state":"%s","link":"https://example/check"}]\n' "$bucket" "$bucket"
  [[ "$bucket" != fail ]] || exit 1
else
  echo "unexpected gh invocation: $args" >&2
  exit 1
fi
SH
chmod +x "$temp_dir/bin/gh"

for baseline in fail pending; do
rm -f "$temp_dir/tick"
PATH="$temp_dir/bin:$PATH" \
CHECK_BASELINE="$baseline" \
FAKE_TICK="$temp_dir/tick" \
TMPDIR="$temp_dir/state" \
MONITOR_PR_PYTHON_BIN="$(command -v python3)" \
PR_MONITOR_COMMENT_FETCH_ATTEMPTS=1 \
PR_MONITOR_COMMENT_FETCH_RETRY_DELAY=0 \
PR_MONITOR_COMMENT_HEALTH_FAILURE_THRESHOLD=2 \
  "$monitor" --repo owner/repo --include-non-employees --interval 0.01 1 >"$temp_dir/out"

# Exactly one real recovery at tick four; tick two is a transport failure.
[[ "$(grep -c 'CI:' "$temp_dir/out")" == 1 ]]
grep -q 'PR #1 closed' "$temp_dir/out"
done
echo "pr-monitor check error tests passed"
