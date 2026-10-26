#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../src-tauri/resources/attention/github-pr" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"
cat > "$temp_dir/bin/gh" <<'PY'
#!/usr/bin/env python3
import os, sys, json, base64
from pathlib import Path
args=' '.join(sys.argv[1:])
authors=['reviewer','builderbot-code-review[bot]','square-task-list-completed[bot]','github-actions[bot]','test-user','outsider','builderbot-code-review-imposter[bot]']
tick_file=Path(os.environ['FAKE_TICK'])
tick=int(tick_file.read_text()) if tick_file.exists() else 0
if args == 'api user --jq .login': print('test-user')
elif args.startswith(('api orgs/squareup/members ', 'api orgs/block/members ')): print('reviewer\ntest-user')
elif 'mergeQueueEntry' in args:
    tick+=1; tick_file.write_text(str(tick))
    state='CLOSED' if tick>=3 else 'OPEN'
    print(f'{state}\tCLEAN\tREVIEW_REQUIRED\tready\tmanual-merge\thttps://example.test/pr/1\tTest PR\tfalse\t\t\t\t')
elif 'reviewThreads(first: 100)' in args:
    nodes=[{'id':a,'isResolved':False,'path':'file.ts','line':1,'comments':{'nodes':[{'author':{'login':a},'bodyText':a+' unresolved','url':'https://example.test/'+a}]}} for a in authors]
    print(json.dumps({'data':{'repository':{'pullRequest':{'reviewThreads':{'nodes':nodes}}}}}))
elif any(p in args for p in ('issues/1/comments','pulls/1/comments','pulls/1/reviews')):
    kind='issue-comment' if 'issues/1/comments' in args else 'review-comment' if 'pulls/1/comments' in args else 'review'
    context='-' if kind=='issue-comment' else 'file.ts:1' if kind=='review-comment' else 'COMMENTED'
    for n,a in enumerate(authors):
        body='b64:'+base64.b64encode(f'{a} feedback {tick}'.encode()).decode()
        print(f'{kind}\t{n+1}\t2026-10-05T00:0{tick}:00Z\t{a}\t{context}\t{body}\thttps://example.test/{kind}/{n}')
elif args.startswith('pr checks '): print('[]')
else: sys.exit('unexpected gh invocation: '+args)
PY
chmod +x "$temp_dir/bin/gh"
export HOME="$temp_dir/home"
mkdir -p "$HOME/.buzz/preferences"
cat > "$HOME/.buzz/preferences/github-pr.json" <<'JSON'
{"version":1,"trustedOrganizations":["squareup"],"trustedAuthors":["builderbot-code-review[bot]","square-task-list-completed[bot]","github-actions[bot]"],"ignoredAuthors":[]}
JSON
for owner in squareup block; do
  mkdir -p "$temp_dir/$owner"
  PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/$owner/tick" TMPDIR="$temp_dir/$owner" \
    "$script_dir/pr-monitor.sh" --repo "$owner/repo" --interval 0.01 1 > "$temp_dir/$owner.out"
  grep -q '12 comments · 4 unresolved' "$temp_dir/$owner.out"
  for author in reviewer 'builderbot-code-review[bot]' 'square-task-list-completed[bot]' 'github-actions[bot]'; do
    for kind in 'commented ·' 'commented on `file.ts:1`' 'reviewed ·' 'has an unresolved thread'; do
      grep -Fq "**$author** $kind" "$temp_dir/$owner.out"
    done
  done
  ! grep -q 'test-user\|outsider\|imposter' "$temp_dir/$owner.out"
  # Suppressed authors still enter snapshots, so their edits cannot replay.
done
# Missing preferences deliver state without comment bodies.
rm "$HOME/.buzz/preferences/github-pr.json"
for mode in default include-self explicit; do
  mkdir -p "$temp_dir/personal-$mode"
  args=()
  [[ "$mode" != include-self ]] || args+=(--include-self-comments)
  if [[ "$mode" == explicit ]]; then
    printf 'reviewer\ntest-user\n' > "$temp_dir/personal-allowlist"
    args+=(--allowlist "$temp_dir/personal-allowlist")
  fi
  PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/personal-$mode/tick" TMPDIR="$temp_dir/personal-$mode" \
    "$script_dir/pr-monitor.sh" --repo test-user/repo --interval 0.01 ${args[@]+"${args[@]}"} 1 > "$temp_dir/personal-$mode.out"
  if [[ "$mode" == explicit ]]; then
    grep -q '3 comments · 1 unresolved' "$temp_dir/personal-$mode.out"
    grep -q '\*\*reviewer\*\* commented ·' "$temp_dir/personal-$mode.out"
  else
    grep -q '0 comments · 0 unresolved' "$temp_dir/personal-$mode.out"
    ! grep -q '· \[view\]' "$temp_dir/personal-$mode.out"
  fi
  ! grep -q 'test-user feedback\|builderbot-code-review\|github-actions\|outsider' "$temp_dir/personal-$mode.out"
  grep -q 'PR #1 \(merged\|closed\)' "$temp_dir/personal-$mode.out"
done
# An injected author policy replaces the bundled one.
printf 'comment_author_is_ignored() { [[ "$1" != outsider ]]; }\n' > "$temp_dir/only-outsider.sh"
mkdir -p "$temp_dir/override"
PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/override/tick" TMPDIR="$temp_dir/override" MONITOR_PR_AUTHOR_POLICY="$temp_dir/only-outsider.sh" \
  "$script_dir/pr-monitor.sh" --repo squareup/repo --interval 0.01 --include-non-employees 1 > "$temp_dir/override.out"
grep -q '\*\*outsider\*\* commented ·' "$temp_dir/override.out"
! grep -q '\*\*reviewer\*\*' "$temp_dir/override.out" || exit 1
# Shared JSON preferences change who is trusted and suppressed.
printf '%s' '{"version":1,"trustedOrganizations":["squareup"],"trustedAuthors":[],"ignoredAuthors":["reviewer"]}' > "$HOME/.buzz/preferences/github-pr.json"
mkdir -p "$temp_dir/defaults"
PATH="$temp_dir/bin:$PATH" FAKE_TICK="$temp_dir/defaults/tick" TMPDIR="$temp_dir/defaults" MONITOR_PR_AUTHOR_DEFAULTS="$temp_dir/defaults.sh" \
  "$script_dir/pr-monitor.sh" --repo squareup/repo --interval 0.01 1 > "$temp_dir/defaults.out"
grep -q '0 comments · 0 unresolved' "$temp_dir/defaults.out"
! grep -q 'reviewer\|github-actions' "$temp_dir/defaults.out" || exit 1
echo 'pr-monitor trusted-author tests passed'
