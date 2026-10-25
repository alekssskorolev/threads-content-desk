"""Local control-flow tests. Fake CLI and HTTP; never create cloud resources."""
import fcntl,json,os,pty,select,signal,subprocess,tempfile,termios,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='td-install-test-') as tmp:
    base=Path(tmp); (base/'bin').mkdir(); (base/'home').mkdir(); (base/'mock').mkdir()
    yc=base/'bin/yc'
    yc.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
a=sys.argv[1:]
with open(os.environ['YC_TEST_LOG'],'a') as f:f.write(json.dumps(a)+'\\n')
if a[:3]==['config','get','folder-id']: print('b1gtestfolder12345678')
elif a[:3]==['resource-manager','folder','get']: print(json.dumps({'id':'b1gtestfolder12345678','name':'test-folder','cloud_id':'b1gtestcloud12345678'}))
elif a[:2]==['iam','service-account']:print(json.dumps({'id':'ajetestservice12345'}))
elif a[:2]==['ydb','database']:print(json.dumps({'id':'etntestdatabase12345','endpoint':'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/b1gtestcloud12345678/etntestdatabase12345'}))
elif a[:3]==['serverless','function','version']:print(json.dumps({'id':'d4etestversion12345'}))
elif a[:2]==['serverless','function']:print(json.dumps({'id':'d4etestfunction12345','http_invoke_url':'https://functions.yandexcloud.net/d4etestfunction12345'}))
else: raise SystemExit('Unhandled yc arguments')
'''); yc.chmod(0o755)
    (base/'mock/sitecustomize.py').write_text('''import urllib.request,urllib.error,json
class Response:
    def __init__(self,status,body,headers=None):self.status=status;self.body=body;self.headers=headers or {}
    def read(self):return json.dumps(self.body).encode()
    def __enter__(self):return self
    def __exit__(self,*a):pass
def fake(req,timeout=0):
    h={k.lower():v for k,v in req.headers.items()}
    if req.method=='OPTIONS':return Response(204,{}, {'Access-Control-Allow-Origin':'https://alekssskorolev.github.io'})
    if h.get('origin')=='https://example.org':return Response(403,{})
    if not h.get('x-desk-key') or h.get('x-desk-key')=='incorrect-key':return Response(401,{})
    op=json.loads(req.data)['op']
    return Response(200,{'roundtrip':True} if op=='init' else {'revision':0,'state':None})
urllib.request.urlopen=fake
''')
    env=dict(os.environ,PATH=str(base/'bin')+':'+os.environ['PATH'],HOME=str(base/'home'),
             YC_TEST_LOG=str(base/'calls.jsonl'),PYTHONPATH=str(base/'mock'))
    def run(answer):
        master,slave=pty.openpty()
        def setup():
            os.setsid(); fcntl.ioctl(slave,termios.TIOCSCTTY,0)
        p=subprocess.Popen(['bash',str(ROOT/'cloud/install.sh')],stdin=slave,stdout=slave,stderr=slave,
                           env=env,preexec_fn=setup)
        os.close(slave); out=b''; sent=False; deadline=time.time()+25
        while p.poll() is None and time.time()<deadline:
            if select.select([master],[],[],0.1)[0]:
                try:chunk=os.read(master,65536)
                except OSError:break
                out+=chunk
                if not sent and 'Введите ДА:'.encode() in out:
                    os.write(master,(answer+'\n').encode());sent=True
        if p.poll() is None:
            p.kill(); p.wait(); raise AssertionError('installer timeout')
        while select.select([master],[],[],0.01)[0]:
            try:out+=os.read(master,65536)
            except OSError:break
        os.close(master)
        assert p.returncode==0, out.decode(errors='replace')
        return out.decode(errors='replace')
    cancel=run('НЕТ')
    calls=[json.loads(line) for line in (base/'calls.jsonl').read_text().splitlines()]
    assert not any('create' in a for a in calls),'Cancellation created resources'
    assert 'Ресурсы не создавались' in cancel
    first=run('ДА'); work=base/'home/.threads-desk-cloud/b1gtestfolder12345678'
    config1=json.loads((work/'client-config.json').read_text())
    assert 'READY_ENDPOINT=https://functions.yandexcloud.net/' in first
    assert config1['key'] not in first,'Secret leaked to console output'
    assert (work/'client-config.json').stat().st_mode & 0o077 == 0
    assert (work/'source/main.py').read_bytes() == (ROOT/'cloud/main.py').read_bytes()
    second=run('ДА');config2=json.loads((work/'client-config.json').read_text())
    assert config1==config2,'Rerun rotated credentials unexpectedly'
    calls=[json.loads(line) for line in (base/'calls.jsonl').read_text().splitlines()]
    for prefix in [['iam','service-account','create'],['ydb','database','create'],['serverless','function','create']]:
        assert sum(a[:3]==prefix for a in calls)==1,('Duplicate resource',prefix)
    grants=[a for a in calls if 'add-access-binding' in a]
    assert all(a[:2]==['ydb','database'] and a[a.index('--role')+1]=='ydb.editor' for a in grants)
    for a in calls:
        assert not any(x in a for x in ['--token','--oauth-token','--key-file'])
    print('Installer checks passed: cancellation, first run, resume, private config, no key output, scoped permissions, embedded source consistency.')
