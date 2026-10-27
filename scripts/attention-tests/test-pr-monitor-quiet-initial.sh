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
tick=0
[[ -f "$FAKE_TICK" ]] && tick=$(cat "$FAKE_TICK")

if [[ "$args" == "api user --jq .login" ]]; then
  echo test-user
elif [[ "$args" == *"mergeQueueEntry"* ]]; then
  tick=$((tick + 1))
  echo "$tick" >"$FAKE_TICK"
  if [[ "$tick" -le 3 ]]; then echo "offline" >&2; exit 1; fi
  state=OPEN
  [[ "$tick" -ge 5 ]] && state=CLOSED
  printf '%s\tCLEAN\tAPPROVED\tready\tmanual-merge\thttps://example.test/pr/1\tTest PR\tfalse\t\t\t\t\n' "$state"
elif [[ "$args" == *"reviewThreads(first: 100)"* ]]; then
  printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
elif [[ "$args" == *"issues/1/comments"* || "$args" == *"pulls/1/comments"* || "$args" == *"pulls/1/reviews"* ]]; then
  :
elif [[ "$args" == "pr checks "* ]]; then
  if [[ "$tick" -lt 5 ]]; then
    printf '%s\n' '[{"name":"build","bucket":"pending","state":"IN_PROGRESS","link":"https://example.test/check"}]'
  else
    printf '%s\n' '[{"name":"build","bucket":"fail","state":"FAILURE","link":"https://example.test/check"},{"name":"slow","bucket":"pending","state":"IN_PROGRESS","link":"https://example.test/slow"}]'
  fi
else
  echo "unexpected gh invocation: $args" >&2
  exit 1
fi
SH
chmod +x "$temp_dir/bin/gh"

PATH="$temp_dir/bin:$PATH" \
FAKE_TICK="$temp_dir/tick" \
TMPDIR="$temp_dir/state" \
MONITOR_PR_PYTHON_BIN="$(command -v python3)" \
  "$monitor" --repo owner/repo --include-non-employees --interval 0.01 --quiet-initial 1 \
  >"$temp_dir/stdout" 2>"$temp_dir/stderr"

grep -q 'PR #1 in owner/repo: open · ready · approved · mergeable · 0 comments · 0 unresolved · checks: 1 pending$' "$temp_dir/stderr"
grep -q '^🔴 CI: .* (1 failed, 1 pending)$' "$temp_dir/stdout"
! grep -q 'PR #1 in owner/repo' "$temp_dir/stdout"
! grep -q '`build` pending' "$temp_dir/stdout"
grep -q '❌ `build` failed' "$temp_dir/stdout"
! grep -q '`slow`' "$temp_dir/stdout"
grep -q '⛔ PR #1 closed' "$temp_dir/stdout"
! grep -q 'PR is now closed' "$temp_dir/stdout"

[[ "$(grep -c "Couldn.t fetch PR" "$temp_dir/stdout")" == 1 ]]
echo "pr-monitor quiet-initial tests passed"
