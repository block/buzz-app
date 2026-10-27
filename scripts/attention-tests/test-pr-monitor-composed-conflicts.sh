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
elif [[ "$args" == *"baseRefName"* ]]; then echo main
elif [[ "$args" == "api repos/owner/repo/branches/main"* ]]; then echo aaaaaaaa
elif [[ "$args" == *"--json mergeable"* ]]; then
  if [[ "$tick" -ge 2 ]]; then echo CONFLICTING; else echo MERGEABLE; fi
elif [[ "$args" == *"mergeQueueEntry"* ]]; then
  tick=$((tick + 1))
  echo "$tick" >"$FAKE_TICK"
  merge=CLEAN
  [[ "$tick" -ge 2 ]] && merge=DIRTY
  state=OPEN
  [[ "$tick" -ge 5 ]] && state=CLOSED
  printf '%s\t%s\tAPPROVED\tready\tmanual-merge\thttps://example.test/pr/1\tTest PR\tfalse\t\t\t\t\n' "$state" "$merge"
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

PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/tick" TMPDIR="$temp_dir/state" MONITOR_PR_PYTHON_BIN="$(command -v python3)" "$script_dir/monitor-pr-with-base.sh" --repo owner/repo --include-non-employees --interval 0.01 --base-interval 0.01 1 >"$temp_dir/stdout" 2>"$temp_dir/stderr"
[[ "$(grep -c 'conflicts with' "$temp_dir/stdout")" == 1 ]]
! grep -q 'PR is now.*conflicting' "$temp_dir/stdout"
