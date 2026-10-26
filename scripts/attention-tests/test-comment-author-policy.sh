#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../src-tauri/resources/attention/github-pr" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/policies/comment-author-policy.sh"
ignored=$'square-kochiku-worker-api\nowner-owl'

assert_ignored() {
  comment_author_is_ignored "$1" "$2" "$3" "$4" "${5:-}" "${6:-0}" || {
    echo "expected ignored: author=$1 current=$2 include=$3" >&2
    exit 1
  }
}
assert_emitted() {
  if comment_author_is_ignored "$1" "$2" "$3" "$4" "${5:-}" "${6:-0}"; then
    echo "expected emitted: author=$1 current=$2 include=$3" >&2
    exit 1
  fi
}

assert_ignored test-user test-user 0 "$ignored"
assert_emitted test-user test-user 1 "$ignored"
assert_ignored 'owner-owl[bot]' test-user 0 "$ignored"
assert_ignored owner-owl test-user 1 "$ignored"
assert_emitted reviewer test-user 0 "$ignored"
assert_emitted reviewer test-user 0 ""
assert_emitted test-user "" 0 "$ignored"

# An active whitelist rejects unknown authors, including an empty roster.
assert_ignored outsider test-user 0 "$ignored" $'reviewer\ntest-user' 1
assert_emitted REVIEWER test-user 0 "$ignored" reviewer 1
assert_ignored unknown test-user 1 "" "" 1
assert_ignored owner-owl test-user 1 "$ignored" owner-owl 1
assert_ignored test-user test-user 0 "" test-user 1
assert_emitted test-user test-user 1 "" test-user 1

# Real organization rosters exceed a pipe buffer; early grep success must not
# cause pipefail to treat a permitted author as denied.
large_roster=$(printf 'reviewer\n'; seq 1 10000)
assert_emitted reviewer test-user 0 "" "$large_roster" 1

echo "comment author policy tests passed"
