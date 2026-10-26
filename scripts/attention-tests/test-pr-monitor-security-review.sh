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
  state=OPEN
  draft_state=draft
  [[ "$tick" -ge 3 ]] && draft_state=ready
  [[ "$tick" -ge 4 ]] && state=CLOSED
  printf '%s\tCLEAN\tREVIEW_REQUIRED\t%s\tmanual-merge\thttps://example.test/pr/1\tTest PR\tfalse\t\t\t\t\n' "$state" "$draft_state"
elif [[ "$args" == *"reviewThreads(first: 100)"* ]]; then
  printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
elif [[ "$args" == *"issues/1/comments"* ]]; then
  if [[ "$tick" -eq 1 ]]; then
    body='<!-- codex-security-review-stale --> head one'
    updated='2026-01-01T00:00:00Z'
  else
    body='<!-- codex-security-review-stale --> head two'
    updated='2026-01-01T00:01:00Z'
  fi
  encoded=$(printf '%s' "$body" | base64 | tr -d '\n')
  printf 'issue-comment\t40\t%s\tgithub-actions[bot]\t-\tb64:%s\thttps://example.test/security\n' "$updated" "$encoded"
elif [[ "$args" == *"pulls/1/comments"* || "$args" == *"pulls/1/reviews"* ]]; then
  :
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
TMPDIR="$temp_dir/state" \
MONITOR_PR_PYTHON_BIN="$(command -v python3)" \
  "$monitor" --repo owner/repo --include-non-employees --interval 0.01 --quiet-initial 1 \
  >"$temp_dir/stdout" 2>"$temp_dir/stderr"

! grep -q 'head one' "$temp_dir/stdout"
[[ "$(grep -c 'head two' "$temp_dir/stdout")" -eq 1 ]]
[[ "$(grep -Fc '💬 **github-actions[bot]** commented ·' "$temp_dir/stdout")" -eq 1 ]]
[[ "$(grep -c 'PR is now' "$temp_dir/stdout" || true)" -eq 0 ]]
grep -q '⛔ PR #1 closed' "$temp_dir/stdout"

echo "pr-monitor security-review deferral tests passed"
