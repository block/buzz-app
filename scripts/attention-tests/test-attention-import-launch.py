"""A fresh install must not invoke a Python installer alias for migration."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
manifest = json.loads((root / 'src/bundled/agents/manifest.json').read_text())
process = next(p for p in manifest['host']['processes'] if p['id'] == 'attention-import')
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    stub = home / 'python3'
    stub.write_text('#!/bin/sh\necho unexpected-python >&2\nexit 97\n')
    stub.chmod(0o755)
    env = {**os.environ, 'HOME': str(home), 'PATH': f'{home}:/usr/bin:/bin'}
    command = [process['interpreter'], str(root / 'src-tauri/resources/attention' / process['program'])]
    for state in ('absent', 'empty', 'archived'):
        folder = home / '.local/state/buzz-monitor/monitors'
        if state != 'absent':
            folder.mkdir(parents=True, exist_ok=True)
        if state == 'archived':
            (folder / 'old.migrated').write_text('{}')
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        assert result.returncode == 0, (state, result.stderr)
        assert json.loads(result.stdout) == []
    wakes = folder.parent / 'wakes'
    wakes.mkdir()
    (wakes / 'pending.json').write_text('{}')
    result = subprocess.run(command, env=env, capture_output=True, text=True)
    assert result.returncode == 97, 'pending wakes must still invoke the importer'
print('Absent, empty and archived legacy stores skip Python; pending wakes invoke it')
