#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../src-tauri/resources/attention/github-pr" && pwd)"
monitor="$script_dir/monitor-pr-with-base.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

cat >"$temp_dir/producer" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${FAKE_PRODUCER_ARGS:-/dev/null}"
sleep 0.1
SH
chmod +x "$temp_dir/producer"

cat >"$temp_dir/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr view" && "$*" == *"baseRefName"* ]]; then
  if [[ "${FAIL_BASE_REF:-0}" == 1 ]]; then echo "base lookup offline" >&2; exit 1; fi
  echo main
elif [[ "$1" == "api" ]]; then
  count=0
  [[ -f "$FAKE_GH_BASE_COUNT" ]] && count=$(<"$FAKE_GH_BASE_COUNT")
  count=$((count + 1))
  echo "$count" >"$FAKE_GH_BASE_COUNT"
  value=$(sed -n "${count}p" "$FAKE_GH_BASE_SEQUENCE")
  [[ -n "$value" ]] || value=$(tail -n 1 "$FAKE_GH_BASE_SEQUENCE")
  printf '%s\n' "$value"
elif [[ "$1 $2" == "pr view" && "$*" == *"mergeable"* ]]; then
  count=0
  [[ -f "$FAKE_GH_REVIEW_COUNT" ]] && count=$(<"$FAKE_GH_REVIEW_COUNT")
  count=$((count + 1))
  echo "$count" >"$FAKE_GH_REVIEW_COUNT"
  value=$(sed -n "${count}p" "$FAKE_GH_REVIEW_SEQUENCE")
  [[ -n "$value" ]] || value=$(tail -n 1 "$FAKE_GH_REVIEW_SEQUENCE")
  printf '%s\n' "$value"
else
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi
SH
chmod +x "$temp_dir/gh"

run_case() {
  local name="$1"
  local base_sequence="$2"
  local review_sequence="$3"
  local output="$temp_dir/$name.out"
  local -a args=(--repo owner/repo --interval 1 --base-interval 0.01)
  printf '%s' "$base_sequence" >"$temp_dir/$name.base"
  printf '%s' "$review_sequence" >"$temp_dir/$name.review"
  rm -f "$temp_dir/$name.base-count" "$temp_dir/$name.review-count"
  FAKE_GH_BASE_COUNT="$temp_dir/$name.base-count" \
  FAKE_GH_BASE_SEQUENCE="$temp_dir/$name.base" \
  FAKE_GH_REVIEW_COUNT="$temp_dir/$name.review-count" \
  FAKE_GH_REVIEW_SEQUENCE="$temp_dir/$name.review" \
  GH_BIN="$temp_dir/gh" \
  MONITOR_PR_PRODUCER="$temp_dir/producer" \
    "$monitor" "${args[@]}" 1 >"$output"
}

run_case draft $'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' $'CONFLICTING\n'
grep -q 'PR #1 conflicts with `main` at aaaaaaaa. Rebase it onto `main`.' "$temp_dir/draft.out"
[[ "$(grep -c 'conflicts with' "$temp_dir/draft.out")" == 1 ]]

run_case mergeable $'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' $'MERGEABLE\nMERGEABLE\n'
! grep -q 'conflicts with' "$temp_dir/mergeable.out"

run_case base-conflict $'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' $'MERGEABLE\nCONFLICTING\n'
grep -q 'base moved aaaaaaaa → bbbbbbbb' "$temp_dir/base-conflict.out"
[[ "$(grep -c 'conflicts with' "$temp_dir/base-conflict.out")" == 1 ]]

run_case unknown-keeps-conflict $'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' $'CONFLICTING\nUNKNOWN\nCONFLICTING\n'
[[ "$(grep -c 'conflicts with' "$temp_dir/unknown-keeps-conflict.out")" == 1 ]]

run_case resolved-then-conflicting $'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' $'CONFLICTING\nMERGEABLE\nCONFLICTING\n'
[[ "$(grep -c 'conflicts with' "$temp_dir/resolved-then-conflicting.out")" == 2 ]]

# Author filters reach the PR producer.
FAKE_GH_BASE_COUNT="$temp_dir/args.base-count" FAKE_GH_BASE_SEQUENCE="$temp_dir/draft.base" \
FAKE_GH_REVIEW_COUNT="$temp_dir/args.review-count" FAKE_GH_REVIEW_SEQUENCE="$temp_dir/draft.review" \
GH_BIN="$temp_dir/gh" MONITOR_PR_PRODUCER="$temp_dir/producer" FAKE_PRODUCER_ARGS="$temp_dir/producer.args" \
  "$monitor" --repo owner/repo --interval 1 --base-interval 0.01 --ignore-author noisy --no-ignore-bots --allowlist roster 1 >/dev/null
[[ "$(tr '\n' ' ' <"$temp_dir/producer.args")" == *"--ignore-author noisy --no-ignore-bots --allowlist roster 1 "* ]]

echo "monitor-pr base-conflict tests passed"

# Fail explicitly, retaining the cause, rather than starting a permanently blind poller.
if FAIL_BASE_REF=1 GH_BIN="$temp_dir/gh" MONITOR_PR_PRODUCER="$temp_dir/producer" "$monitor" --repo owner/repo 1 >"$temp_dir/fail.out" 2>"$temp_dir/fail.err"; then
  echo "accepted a failed base lookup" >&2
  exit 1
fi
grep -q 'base lookup offline' "$temp_dir/fail.err"
