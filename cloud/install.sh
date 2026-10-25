#!/usr/bin/env bash
# Threads Desk / Yandex Cloud. Runs ONLY inside your own authorized Cloud Shell.
# No OAuth/API keys are created, requested, transmitted to GitHub or sent to chat.
set -Eeuo pipefail
umask 077
export LC_ALL=C.UTF-8
trap 'printf "\nУстановка остановлена (строка %s). Существующие данные сайта не изменены.\nРесурсы, созданные до ошибки, могут остаться в облаке. Повторите ту же команду.\nНе отправляйте в чат client-config.json или ключ доступа.\n" "$LINENO" >&2' ERR
for tool in yc python3; do
  command -v "$tool" >/dev/null || { echo "Не найден $tool. Запускайте в Yandex Cloud Shell." >&2; exit 1; }
done
FOLDER="${DESK_FOLDER_ID:-$(yc config get folder-id 2>/dev/null || true)}"
if [[ ! "$FOLDER" =~ ^[a-z0-9]{10,40}$ ]]; then
  echo 'Каталог не выбран. Доступные каталоги:'
  yc resource-manager folder list
  read -r -p 'Вставьте ID нужного каталога из списка: ' FOLDER </dev/tty
fi
[[ "$FOLDER" =~ ^[a-z0-9]{10,40}$ ]] || { echo 'Некорректный ID каталога.' >&2; exit 1; }
FOLDER_INFO=$(yc resource-manager folder get --id "$FOLDER" --format json)
printf '%s' "$FOLDER_INFO" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\nКаталог:",d["name"],"/",d["id"],"\nОблако:",d.get("cloud_id","?"))'
cat <<'NOTICE'

Будут созданы только:
 • 1 YDB Serverless (не выделенный сервер): лимит хранения 1 GB,
   до 50 RU/s, без оплачиваемой provisioned capacity.
 • 1 Cloud Function: Python, 256 MB, тайм-аут 30 секунд.
 • 1 сервисный аккаунт с ролью ydb.editor ТОЛЬКО на новой базе.

База не публичная. HTTP-функция вызывается публично, но операции требуют
отдельного случайного ключа. Ключ от Яндекс Cloud в браузер не передаётся.
API Gateway, виртуальных машин, платных дисков и постоянных процессов нет.
Функции и YDB тарифицируются по использованию; у них есть бесплатные пакеты.
Нулевая стоимость не гарантируется. Лимиты ресурсов — НЕ денежный бюджет;
даже отклонённые HTTP-запросы могут расходовать лимит вызовов функции.
Платёжный аккаунт должен быть активен. Баланс/тариф скрипт не меняет.
Сайт и его локальные отметки на этом этапе не меняются.
NOTICE
read -r -p 'Создать ресурсы в этом каталоге? Введите ДА: ' ANSWER </dev/tty
[[ "$ANSWER" == 'ДА' ]] || { echo 'Отменено. Ресурсы не создавались.'; exit 0; }
WORK="$HOME/.threads-desk-cloud/$FOLDER"
mkdir -p "$WORK"
chmod 700 "$WORK"
if [[ ! -s "$WORK/name" ]]; then
  python3 -c 'import secrets; print("td-sync-"+secrets.token_hex(5))' > "$WORK/name"
fi
NAME=$(cat "$WORK/name")
[[ "$NAME" =~ ^td-sync-[a-f0-9]{10}$ ]] || { echo 'Некорректный файл установки.' >&2; exit 1; }
ID() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$1"; }
if [[ ! -s "$WORK/key" ]]; then
  python3 -c 'import secrets; print(secrets.token_hex(32))' > "$WORK/key"
fi
KEY_HASH=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1]).read().strip().encode()).hexdigest())' "$WORK/key")

echo '[1/5] Сервисный аккаунт…'
if [[ ! -s "$WORK/sa.json" ]]; then
  yc iam service-account create --folder-id "$FOLDER" --name "$NAME" \
    --description 'Threads Desk: service account for one dedicated sync database' --format json > "$WORK/sa.tmp"
  mv "$WORK/sa.tmp" "$WORK/sa.json"
fi
SA_ID=$(ID "$WORK/sa.json")
yc iam service-account get --id "$SA_ID" --format json > /dev/null

echo '[2/5] База YDB Serverless (создание может занять несколько минут)…'
if [[ ! -s "$WORK/db.json" ]]; then
  yc ydb database create --folder-id "$FOLDER" --name "$NAME" --serverless --location ru-central1 \
    --sls-storage-size 1GB --sls-enable-throttling-rcu --sls-throttling-rcu 50 \
    --sls-provisioned-rcu 0 --labels application=threads-desk --format json > "$WORK/db.tmp"
  mv "$WORK/db.tmp" "$WORK/db.json"
fi
DB_ID=$(ID "$WORK/db.json")
yc ydb database get --id "$DB_ID" --format json > "$WORK/db-live.json"
yc ydb database add-access-binding --id "$DB_ID" --role ydb.editor --service-account-id "$SA_ID" > /dev/null
# Parse returned endpoint; do not guess database paths or service addresses.
python3 - "$WORK" <<'PARSE'
import json,pathlib,sys,urllib.parse
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'db-live.json').read_text())
e=d['endpoint']; u=urllib.parse.urlsplit(e)
path=urllib.parse.parse_qs(u.query).get('database',[d.get('database_path','')])[0]
if u.scheme!='grpcs' or not u.netloc or not path.startswith('/'):
    raise SystemExit('Не удалось разобрать endpoint YDB. Остановлено без изменения данных.')
(p/'ydb-endpoint').write_text(f'{u.scheme}://{u.netloc}')
(p/'ydb-path').write_text(path)
PARSE
YDB_ENDPOINT=$(cat "$WORK/ydb-endpoint")
YDB_DATABASE=$(cat "$WORK/ydb-path")

echo '[3/5] Облачная функция…'
if [[ ! -s "$WORK/function.json" ]]; then
  yc serverless function create --folder-id "$FOLDER" --name "$NAME" \
    --description 'Threads Desk: authenticated state sync API' --format json > "$WORK/function.tmp"
  mv "$WORK/function.tmp" "$WORK/function.json"
fi
FUNCTION_ID=$(ID "$WORK/function.json")
mkdir -p "$WORK/source"
cat > "$WORK/source/main.py" <<'PYTHON_SOURCE'
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
PYTHON_SOURCE
printf 'ydb==3.33.2\n' > "$WORK/source/requirements.txt"
python3 - "$WORK" <<'ZIP'
import pathlib,sys,zipfile
p=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(p/'function.zip','w',zipfile.ZIP_DEFLATED) as z:
    for name in ('main.py','requirements.txt'):
        z.write(p/'source'/name,name)
ZIP
yc serverless function version create --folder-id "$FOLDER" --function-id "$FUNCTION_ID" \
  --runtime python312 --entrypoint main.handler --memory 256MB --execution-timeout 30s \
  --service-account-id "$SA_ID" --source-path "$WORK/function.zip" --no-logging \
  --environment "YDB_ENDPOINT=$YDB_ENDPOINT" --environment "YDB_DATABASE=$YDB_DATABASE" \
  --environment "DESK_KEY_SHA256=$KEY_HASH" \
  --environment 'ALLOWED_ORIGIN=https://alekssskorolev.github.io' --format json > "$WORK/version.json"
yc serverless function allow-unauthenticated-invoke --id "$FUNCTION_ID" > /dev/null
yc serverless function get --id "$FUNCTION_ID" --format json > "$WORK/function-live.json"
python3 - "$WORK" <<'CONFIG'
import json,pathlib,sys,urllib.parse
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'function-live.json').read_text())
url=d.get('http_invoke_url')
u=urllib.parse.urlsplit(url or '')
if u.scheme!='https' or u.hostname!='functions.yandexcloud.net' or not u.path.strip('/'):
    raise SystemExit('Не найден корректный http_invoke_url. Остановлено.')
config={'kind':'threads-desk-cloud-config','version':1,'endpoint':url,'key':(p/'key').read_text().strip()}
(p/'client-config.json').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
(p/'endpoint').write_text(url)
CONFIG

echo '[4/5] Проверка записи/чтения/удаления тестовой записи и защиты доступа…'
python3 - "$WORK/client-config.json" <<'CHECK'
import json,pathlib,sys,time,urllib.request,urllib.error
c=json.loads(pathlib.Path(sys.argv[1]).read_text())
def call(op,key=None,origin=None,method='POST'):
    h={'Content-Type':'application/json'}
    if key: h['X-Desk-Key']=key
    if origin: h['Origin']=origin
    req=urllib.request.Request(c['endpoint'],data=json.dumps({'op':op}).encode() if method=='POST' else None,headers=h,method=method)
    try:
        with urllib.request.urlopen(req,timeout=40) as r:
            return r.status,r.read(),r.headers
    except urllib.error.HTTPError as e:
        return e.code,e.read(),e.headers
for attempt in range(30):
    try:
        status,body,_=call('init',c['key'])
        if status==200 and json.loads(body).get('roundtrip') is True: break
        if status not in (401,429,500,502,503,504):
            raise SystemExit(f'Проверка не пройдена: HTTP {status}. Ключ и конфиг не отправляйте в чат.')
    except (urllib.error.URLError,TimeoutError): pass
    if attempt==29: raise SystemExit('Проверка базы не завершилась. Повторите установку; данные не перезаписывались.')
    print(f'Ожидаем готовность функции/прав доступа ({attempt+1}/30)…',flush=True)
    time.sleep(5)
assert call('get')[0]==401,'Доступ без ключа должен быть запрещён'
assert call('get','incorrect-key')[0]==401,'Неверный ключ должен быть отклонён'
assert call('get',c['key'],'https://example.org')[0]==403,'Посторонний Origin должен быть отклонён'
status,_,headers=call('get',None,'https://alekssskorolev.github.io',method='OPTIONS')
assert status==204 and headers.get('Access-Control-Allow-Origin')=='https://alekssskorolev.github.io','Ошибка CORS'
status,body,_=call('get',c['key'],'https://alekssskorolev.github.io')
assert status==200 and type(json.loads(body).get('revision')) is int,'Ошибка чтения состояния'
print('Проверки пройдены. Основная запись с отметками не изменялась.')
CHECK

echo '[5/5] Сохранение инструкции удаления…'
# Deletion is always separate and requires confirmation. No automatic rollback of user data.
cat > "$WORK/remove.sh" <<REMOVE
#!/usr/bin/env bash
set -euo pipefail
read -r -p 'Удалить облачную базу Threads Desk и ВСЕ её отметки? Введите УДАЛИТЬ: ' ANSWER </dev/tty
[[ "\$ANSWER" == 'УДАЛИТЬ' ]] || exit 0
yc serverless function delete --id '$FUNCTION_ID'
yc ydb database delete --id '$DB_ID'
yc iam service-account delete --id '$SA_ID'
echo 'Облачные ресурсы удалены. Локальные резервные копии не удалялись.'
REMOVE
chmod 700 "$WORK/remove.sh"
printf '\nГОТОВО: база и функция созданы, проверка пройдена.\nREADY_ENDPOINT=%s\n' "$(cat "$WORK/endpoint")"
printf '\nВ чат можно отправить ТОЛЬКО строку READY_ENDPOINT выше (она не секретная).\n'
printf 'Секретный конфиг для подключения сайта сохранён здесь:\n  %s/client-config.json\n' "$WORK"
printf 'Не отправляйте его, ключ или скриншот ключа в чат/публичный репозиторий.\n'
printf 'Удаление всех созданных ресурсов (только при необходимости):\n  bash %q\n' "$WORK/remove.sh"
printf '\nСайт пока работает по-прежнему локально. Следующий этап — подключить его к этой базе.\n'
