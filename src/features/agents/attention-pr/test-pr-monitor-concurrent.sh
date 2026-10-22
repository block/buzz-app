#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/state"
cat > "$tmp/bin/gh" <<'SH'
#!/bin/bash
case "$*" in
  'api user --jq .login') echo tester ;;
  *mergeQueueEntry*)
    touch "$BARRIER/$RUN_ID"
    for attempt in {1..100}; do
      [[ -f "$BARRIER/a" && -f "$BARRIER/b" ]] && break
      sleep .05
    done
    printf 'CLOSED\tCLEAN\tAPPROVED\tready\tmanual-merge\thttps://github.com/example/repo/pull/1\tTest\tfalse\t\t\t\t\n'
    ;;
  *'reviewThreads(first: 100)'*) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
  'pr checks '*) echo '[]' ;;
  *comments*|*reviews*) : ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;
esac
SH
chmod +x "$tmp/bin/gh"
for run in a b; do
  env -u PR_MONITOR_STATE_DIRECTORY PATH="$tmp/bin:$PATH" TMPDIR="$tmp/state" BARRIER="$tmp" RUN_ID="$run" bash "$here/pr-monitor.sh" --once --include-non-employees https://github.com/example/repo/pull/1 > "$tmp/$run.out" 2> "$tmp/$run.err" &
  if [[ "$run" == a ]]; then first=$!; else second=$!; fi
done
status=0
wait "$first" || status=1
wait "$second" || status=1
if (( status )); then cat "$tmp/"*.err >&2; exit 1; fi
echo 'Concurrent PR monitors have independent state: ok'
