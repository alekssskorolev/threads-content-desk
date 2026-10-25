"""Private, single-owner Threads Desk state API. No cloud keys in the browser."""
import base64
import hashlib
import hmac
import json
import os
import secrets

import ydb
import ydb.iam

_POOL = None
MAX_BYTES = 512_000
TABLE = 'desk_state'
READ = 'DECLARE $id AS Utf8; SELECT payload, revision FROM `desk_state` WHERE id = $id;'
WRITE = ('DECLARE $id AS Utf8; DECLARE $payload AS Utf8; DECLARE $revision AS Uint64; '
         'UPSERT INTO `desk_state` (id, payload, revision) VALUES ($id, $payload, $revision);')
DELETE = 'DECLARE $id AS Utf8; DELETE FROM `desk_state` WHERE id = $id;'


def pool():
    global _POOL
    if _POOL is None:
        driver = ydb.Driver(endpoint=os.environ['YDB_ENDPOINT'],
                            database=os.environ['YDB_DATABASE'],
                            credentials=ydb.iam.MetadataUrlCredentials())
        driver.wait(fail_fast=True, timeout=8)
        _POOL = ydb.SessionPool(driver, size=2)
    return _POOL


def settings():
    return ydb.BaseRequestSettings().with_timeout(8).with_operation_timeout(6)


def execute(tx, session, query, params, commit=False):
    return tx.execute(session.prepare(query), params, commit_tx=commit, settings=settings())


def load_state(session):
    rows = execute(session.transaction(ydb.SerializableReadWrite()), session, READ,
                   {'$id': 'main'}, commit=True)[0].rows
    if not rows:
        return {'revision': 0, 'state': None}
    return {'revision': rows[0].revision, 'state': json.loads(rows[0].payload)}


def store_state(session, expected, payload):
    with session.transaction(ydb.SerializableReadWrite()) as tx:
        rows = execute(tx, session, READ, {'$id': 'main'})[0].rows
        current = rows[0].revision if rows else 0
        if current != expected:
            tx.rollback()
            return {'conflict': True, 'revision': current}
        execute(tx, session, WRITE,
                {'$id': 'main', '$payload': payload, '$revision': current + 1}, commit=True)
        return {'revision': current + 1}


def initialize(session):
    path = os.environ['YDB_DATABASE'].rstrip('/') + '/' + TABLE
    try:
        session.describe_table(path, settings=settings())
    except ydb.SchemeError:
        try:
            session.execute_scheme('CREATE TABLE `desk_state` ('
                                   'id Utf8 NOT NULL, payload Utf8, revision Uint64, PRIMARY KEY (id));',
                                   settings=settings())
        except ydb.SchemeError:
            # A concurrent installer may have created it. Check rather than ignore errors.
            session.describe_table(path, settings=settings())
    return True


def roundtrip():
    """Use a separate probe row. Never read/overwrite the user's main state."""
    row_id = '__setup_check__' + secrets.token_hex(12)
    payload = json.dumps({'probe': secrets.token_hex(12)})
    p = pool()

    def write(session):
        return execute(session.transaction(ydb.SerializableReadWrite()), session, WRITE,
                       {'$id': row_id, '$payload': payload, '$revision': 1}, commit=True)

    def read(session):
        rows = execute(session.transaction(ydb.SerializableReadWrite()), session, READ,
                       {'$id': row_id}, commit=True)[0].rows
        if len(rows) != 1 or rows[0].payload != payload or rows[0].revision != 1:
            raise RuntimeError('roundtrip_failed')

    def delete(session):
        return execute(session.transaction(ydb.SerializableReadWrite()), session, DELETE,
                       {'$id': row_id}, commit=True)

    try:
        p.retry_operation_sync(write)
        p.retry_operation_sync(read)
    finally:
        p.retry_operation_sync(delete)


def handler(event, context):
    headers = {str(k).lower(): str(v) for k, v in (event.get('headers') or {}).items()}
    origin = headers.get('origin', '')
    allowed = os.environ.get('ALLOWED_ORIGIN', '')
    response_headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
                        'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff'}
    if origin and origin == allowed:
        response_headers.update({'Access-Control-Allow-Origin': allowed,
                                 'Access-Control-Allow-Methods': 'POST, OPTIONS',
                                 'Access-Control-Allow-Headers': 'Content-Type, X-Desk-Key',
                                 'Access-Control-Max-Age': '600'})

    def reply(status, body):
        return {'statusCode': status, 'headers': response_headers,
                'isBase64Encoded': False, 'body': json.dumps(body, ensure_ascii=False, allow_nan=False)}

    if origin and origin != allowed:
        return reply(403, {'error': 'origin_denied'})
    method = event.get('httpMethod', '')
    if method == 'OPTIONS':
        return reply(204, {})
    if method != 'POST':
        return reply(405, {'error': 'method_not_allowed'})
    key = headers.get('x-desk-key', '')
    expected_hash = os.environ.get('DESK_KEY_SHA256', '')
    if not key or len(expected_hash) != 64 or not hmac.compare_digest(
            hashlib.sha256(key.encode()).hexdigest(), expected_hash):
        return reply(401, {'error': 'unauthorized'})
    try:
        raw = event.get('body') or ''
        if event.get('isBase64Encoded'):
            raw = base64.b64decode(raw, validate=True).decode('utf-8')
        if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_BYTES:
            return reply(413, {'error': 'too_large'})
        data = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        if not isinstance(data, dict):
            raise ValueError('object_required')
        op = data.get('op')
        payload = None
        if op == 'put':
            value = data.get('state')
            revision = data.get('expectedRevision')
            if (not isinstance(value, dict) or value.get('kind') != 'threads-desk-backup'
                    or value.get('version') != 1 or not isinstance(value.get('records'), dict)
                    or type(revision) is not int or not 0 <= revision < 2**53 - 1):
                raise ValueError('invalid_state')
            payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        elif op not in ('init', 'get'):
            raise ValueError('unknown_operation')
    except (ValueError, TypeError, UnicodeError):
        return reply(400, {'error': 'invalid_request'})
    try:
        p = pool()
        if op == 'init':
            p.retry_operation_sync(initialize)
            roundtrip()
            return reply(200, {'ok': True, 'storage': 'ydb', 'roundtrip': True})
        if op == 'get':
            return reply(200, p.retry_operation_sync(load_state))
        result = p.retry_operation_sync(lambda session: store_state(session, revision, payload))
        return reply(409 if result.get('conflict') else 200, result)
    except Exception:
        # Deliberately omit keys, payloads, SQL, cloud identifiers and exception messages.
        return reply(503, {'error': 'storage_unavailable'})
