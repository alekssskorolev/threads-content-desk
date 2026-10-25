import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desk_api', ROOT/'cloud/main.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
KEY = 'local-unit-test-key-not-a-real-credential'
ORIGIN = 'https://alekssskorolev.github.io'
os.environ.update(DESK_KEY_SHA256=hashlib.sha256(KEY.encode()).hexdigest(),
                  ALLOWED_ORIGIN=ORIGIN, YDB_DATABASE='/test')

class Session:
    def __init__(self):
        self.rows = {}
        self.table = False
        self.rollbacks = 0
        self.commits = 0
    def prepare(self, q): return q
    def transaction(self, mode): return Tx(self)
    def describe_table(self, path, settings=None):
        if not self.table: raise api.ydb.SchemeError('missing')
    def execute_scheme(self, query, settings=None): self.table = True

class Tx:
    def __init__(self, session):
        self.s = session
        self.rows = copy.deepcopy(session.rows)
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def rollback(self): self.s.rollbacks += 1
    def execute(self, query, parameters=None, commit_tx=False, settings=None):
        p = parameters
        result = [SimpleNamespace(rows=[])]
        if query == api.READ:
            row = self.rows.get(p['$id'])
            result[0].rows = [SimpleNamespace(**row)] if row else []
        elif query == api.WRITE:
            self.rows[p['$id']] = {'payload':p['$payload'], 'revision':p['$revision']}
        elif query == api.DELETE: self.rows.pop(p['$id'], None)
        else: raise AssertionError('Unknown query')
        if commit_tx:
            self.s.rows = self.rows
            self.s.commits += 1
        return result

class Pool:
    def __init__(self): self.session = Session()
    def retry_operation_sync(self, fn): return fn(self.session)

class APITests(unittest.TestCase):
    def setUp(self):
        self.p = Pool()
        api._POOL = self.p
    def call(self, data, key=KEY, origin=ORIGIN, method='POST', **extras):
        event={'httpMethod':method,'headers':{},'body':json.dumps(data)}
        if key is not None: event['headers']['X-Desk-Key'] = key
        if origin: event['headers']['Origin'] = origin
        event.update(extras)
        return api.handler(event, None)
    def body(self, r): return json.loads(r['body'])
    def put(self, rev, done):
        return self.call({'op':'put','expectedRevision':rev,'state':{
            'kind':'threads-desk-backup','version':1,'records':{'A0':{'done':done}},
            'schedule_mode':'auto'}})
    def test_auth_no_database_access(self):
        for key in (None,'wrong'):
            self.assertEqual(self.call({'op':'get'},key=key)['statusCode'],401)
        self.assertEqual(self.p.session.commits,0)
    def test_cors(self):
        r=self.call({}, key=None,method='OPTIONS')
        self.assertEqual(r['statusCode'],204)
        self.assertEqual(r['headers']['Access-Control-Allow-Origin'],ORIGIN)
        r=self.call({'op':'get'},origin='https://evil.example')
        self.assertEqual(r['statusCode'],403)
        self.assertNotIn('Access-Control-Allow-Origin',r['headers'])
    def test_empty(self):
        self.assertEqual(self.body(self.call({'op':'get'})),{'revision':0,'state':None})
    def test_roundtrip_and_conflict(self):
        self.assertEqual(self.body(self.put(0,True)),{'revision':1})
        r=self.put(0,False)
        self.assertEqual(r['statusCode'],409)
        self.assertEqual(self.body(r)['revision'],1)
        self.assertEqual(self.p.session.rollbacks,1)
        value=self.body(self.call({'op':'get'}))
        self.assertTrue(value['state']['records']['A0']['done'])
        self.assertEqual(value['state']['schedule_mode'],'auto')
        self.assertEqual(self.body(self.put(1,False)),{'revision':2})
        self.assertFalse(self.body(self.call({'op':'get'}))['state']['records']['A0']['done'])
    def test_init_keeps_main_and_removes_probe(self):
        self.put(0,True)
        before=copy.deepcopy(self.p.session.rows)
        for _ in range(2):
            r=self.call({'op':'init'})
            self.assertEqual(r['statusCode'],200)
            self.assertTrue(self.body(r)['roundtrip'])
            self.assertEqual(self.p.session.rows,before)
    def test_bad_inputs(self):
        for value in [[],None,{}, {'op':'nonsense'},
                      {'op':'put','expectedRevision':True,'state':{}},
                      {'op':'put','expectedRevision':-1,'state':{}},
                      {'op':'put','expectedRevision':0,'state':{'kind':'wrong'}}]:
            self.assertEqual(self.call(value)['statusCode'],400)
        self.assertEqual(self.call({},body='{"op":"get","n":NaN}')['statusCode'],400)
        self.assertEqual(self.call({},body='not JSON')['statusCode'],400)
        self.assertEqual(self.call({},body='x'*(api.MAX_BYTES+1))['statusCode'],413)
        self.assertEqual(self.call({},body='wrong base64',isBase64Encoded=True)['statusCode'],400)
    def test_base64(self):
        import base64
        r=self.call({},body=base64.b64encode(b'{"op":"get"}').decode(),isBase64Encoded=True)
        self.assertEqual(r['statusCode'],200)
    def test_method(self):
        self.assertEqual(self.call({},method='GET')['statusCode'],405)
    def test_fail_closed_missing_env(self):
        previous=os.environ.pop('DESK_KEY_SHA256')
        try: self.assertEqual(self.call({'op':'get'})['statusCode'],401)
        finally: os.environ['DESK_KEY_SHA256']=previous
    def test_storage_failure_does_not_leak(self):
        def fail(fn): raise RuntimeError('secret-database-info')
        self.p.retry_operation_sync=fail
        r=self.call({'op':'get'})
        self.assertEqual(r['statusCode'],503)
        self.assertNotIn('secret-database-info',r['body'])
        self.assertNotIn(KEY,r['body'])

if __name__=='__main__': unittest.main(verbosity=2)
