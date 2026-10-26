import sys
sys.dont_write_bytecode = True
import importlib.util
import json
from pathlib import Path
from importlib.machinery import SourceFileLoader
import tempfile

spec = importlib.util.spec_from_loader('migration', SourceFileLoader('migration', str(Path(__file__).resolve().parents[2] / 'src-tauri/resources/attention/buzz-attention-import')))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    folder = Path(directory)
    p = folder/'check.json'
    raw = {'argv':['--name','check','--channel','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','--mention','a'*64,'--instructions','Watch','--','printf','hello'], 'cwd':'/tmp','env':{'TOKEN':'not-copied'}}
    p.write_text(json.dumps(raw))
    value=m.parse(p)
    assert value['command']==['printf','hello']
    assert 'env' not in value
    p.write_text(json.dumps({**raw,'cwd':'/other'}))
    try:m.main(folder,['archive',p.name,value['signature']])
    except ValueError:pass
    else:raise AssertionError('changed record archived')
    assert p.exists()
    value=m.parse(p)
    m.main(folder,['archive',p.name,value['signature']])
    assert not p.exists() and p.with_suffix('.migrated').exists()
print('Real registration parse, credential exclusion, changed-snapshot rejection and archive passed')
