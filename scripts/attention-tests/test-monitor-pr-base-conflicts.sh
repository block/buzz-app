#!/usr/bin/env bash
set -euo pipefail
python3 - "$(cd "$(dirname "$0")/../.." && pwd)" <<'PY'
import os, pathlib, subprocess, sys, tempfile
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as directory:
    temp = pathlib.Path(directory)
    gh = temp / 'gh'
    gh.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
args = ' '.join(sys.argv[1:])
path = pathlib.Path(os.environ['FAKE_TICK'])
tick = int(path.read_text()) if path.exists() else 0
if 'mergeQueueEntry' in args:
    tick += 1
    path.write_text(str(tick))
    states = os.environ['SEQUENCE'].split(',')
    if tick <= int(os.environ.get('FAIL_COUNT', '0')):
        sys.exit(1)
    conflict = states[min(tick - int(os.environ.get('FAIL_COUNT', '0')) - 1, len(states)-1)]
    state = 'CLOSED' if tick > len(states) + int(os.environ.get('FAIL_COUNT', '0')) else 'OPEN'
    print('\\t'.join([state, 'UNKNOWN', 'APPROVED', 'draft', 'manual-merge', 'https://example/pr/1', 'Test', 'false', '', '', '', '', conflict, os.environ.get('BASE_REF', 'main'), os.environ.get('BASE_SHA', 'aaaaaaaa')]))
elif args == 'api user --jq .login': print('test-user')
elif 'reviewThreads(first: 100)' in args:
    print('{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}')
elif args.startswith('pr checks '): print('[]')
elif 'comments' in args or 'reviews' in args: pass
else: sys.exit('unexpected gh invocation: ' + args)
''')
    gh.chmod(0o755)
    def run(name, sequence, conflicts, failures=0, missing=False):
        tick = temp / (name + '.tick')
        state = temp / name
        state.mkdir()
        env = dict(os.environ, PATH=str(temp)+os.pathsep+os.environ['PATH'], TMPDIR=str(state), FAKE_TICK=str(tick), SEQUENCE=sequence, FAIL_COUNT=str(failures))
        if missing: env.update(BASE_REF='', BASE_SHA='')
        result = subprocess.run([str(root/'src-tauri/resources/attention/buzz-attention-pr'), '--repo', 'owner/repo', '--include-non-employees', '--interval', '0.01', '1'], env=env, capture_output=True, text=True, timeout=10, check=True)
        assert result.stdout.count('conflicts with') == conflicts, result.stdout
        assert 'PR #1 closed' in result.stdout, result.stdout
        assert result.stdout.count("Couldn't fetch PR") == bool(failures), result.stdout
    run('draft', 'CONFLICTING', 1)
    run('mergeable', 'MERGEABLE,MERGEABLE', 0)
    run('later', 'MERGEABLE,CONFLICTING', 1)
    run('unknown', 'CONFLICTING,UNKNOWN,CONFLICTING', 1)
    run('resolved', 'CONFLICTING,MERGEABLE,CONFLICTING', 2)
    run('recovery', 'MERGEABLE,CONFLICTING', 1, failures=2)
    run('missing-base', 'UNKNOWN', 0, missing=True)
print('single-owner conflict and recovery tests passed')
PY
