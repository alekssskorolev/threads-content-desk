/* Threads Desk single-owner cloud sync. Secrets live only in this browser, never in backups. */
(function () {
  'use strict';
  const CONFIG_KEY = 'threads-desk-cloud-v1';
  const META_KEY = 'threads-desk-cloud-meta-v1';
  const BACKUP_KEY = 'threads-desk-before-cloud-v1';
  const ENDPOINT = 'https://functions.yandexcloud.net/d4emlk00avk75e7ldlp7';
  const empty = () => ({kind: 'threads-desk-backup', version: 1, records: {}});
  const clone = v => JSON.parse(JSON.stringify(v));
  const signature = v => JSON.stringify(v, function (key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((o, k) => { Object.defineProperty(o, k, {value: value[k], enumerable: true}); return o; }, {});
    }
    return value;
  });
  const same = (a, b) => signature(a) === signature(b);
  const meaningful = s => Object.values(s.records || {}).some(r => r.done || r.url || r.history?.length || r.include_short || r.scheduled_slot);
  const count = s => Object.values(s.records || {}).filter(r => r.done).length;
  function validConfig(c) {
    return c && c.version === 1 && c.endpoint === ENDPOINT && typeof c.key === 'string' && /^[a-f0-9]{64}$/.test(c.key);
  }
  function merge(base, local, remote, preference) {
    const result = clone(remote), conflicts = [];
    const choose = (b, l, r, label) => {
      if (same(l, b)) return r;
      if (same(r, b) || same(l, r)) return l;
      conflicts.push(label);
      return preference === 'local' ? l : r;
    };
    for (const field of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      if (field === 'records' || field === 'exported_at') continue;
      const value = choose(base[field], local[field], remote[field], field);
      if (value === undefined) delete result[field]; else result[field] = clone(value);
    }
    result.records = {};
    for (const id of new Set([...Object.keys(base.records), ...Object.keys(local.records), ...Object.keys(remote.records)])) {
      const value = choose(base.records[id], local.records[id], remote.records[id], id);
      if (value !== undefined) Object.defineProperty(result.records, id, {value: clone(value), enumerable: true});
    }
    delete result.exported_at;
    return {state: result, conflicts};
  }
  function create(a) {
    const $ = id => document.getElementById(id);
    let config = null, invalidConfig = false, base = null, revision = 0;
    let dirty = false, busy = false, timer = null, initialized = false, blocked = false;
    let lastError = false, paused = null, decision = null, alive = true;
    function status(text, level = '', retry = false) {
      $('cloudBar').hidden = !config && !invalidConfig;
      $('cloudBar').dataset.level = level;
      $('cloudStatus').textContent = text;
      $('cloudRetry').hidden = !retry;
      $('cloudDisconnect').hidden = !config && !invalidConfig;
      $('cloudShare').hidden = !config;
      try { $('cloudBackup').hidden = !localStorage.getItem(BACKUP_KEY); } catch (_) {}
    }
    function persist() {
      if (!config || base === null) return;
      try {
        localStorage.setItem(META_KEY, JSON.stringify({version: 1, endpoint: config.endpoint,
          revision, base, snapshot: a.read(), dirty}));
      } catch (_) {
        status('Не удалось сохранить очередь синхронизации. Скачайте резервную копию.', 'error', true);
        a.toast('Хранилище браузера переполнено. Не закрывайте страницу без резервной копии.');
      }
    }
    function apply(value) {
      a.validate(value);
      a.apply(clone(value));
    }
    function backup(value) {
      // Keep a snapshot before replacing local state; never include credentials.
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify({saved_at: new Date().toISOString(), state: value}));
        $('cloudBackup').hidden = false;
      } catch (_) {
        a.download('threads-desk-before-cloud.json', JSON.stringify(value, null, 2), 'application/json');
        a.toast('Резервная копия скачана. Сохраните её перед продолжением.');
      }
    }
    function hideChoice() {
      paused = null;
      $('cloudChoice').hidden = true;
      $('cloudChoiceButtons').replaceChildren();
    }
    function choice(type, title, text, buttons) {
      paused = type;
      status(type === 'conflict' ? 'Конфликт изменений — выберите вариант ниже.' : 'Подключение: выберите, какие отметки использовать.', 'warning');
      $('cloudChoice').hidden = false;
      $('cloudChoiceTitle').textContent = title;
      $('cloudChoiceText').textContent = text;
      $('cloudChoiceButtons').replaceChildren();
      for (const [label, action] of buttons) {
        const button = document.createElement('button');
        button.textContent = label;
        button.onclick = () => { if (!busy) action(); };
        $('cloudChoiceButtons').append(button);
      }
    }
    async function request(body) {
      const response = await fetch(config.endpoint, {method: 'POST', cache: 'no-store', credentials: 'omit',
        referrerPolicy: 'no-referrer', headers: {'Content-Type': 'application/json', 'X-Desk-Key': config.key},
        body: JSON.stringify(body), signal: AbortSignal.timeout(35000)});
      if (!alive) throw Error('disconnected');
      if (response.status === 401) throw Error('key');
      if (response.status === 413) throw Error('size');
      if (response.status === 409) return {conflict: true};
      if (!response.ok) throw Error('http_' + response.status);
      return response.json();
    }
    async function remoteState() {
      const r = await request({op: 'get'});
      if (!Number.isSafeInteger(r.revision) || r.revision < 0 || (r.state === null && r.revision !== 0)) throw Error('format');
      const value = r.state === null ? empty() : r.state;
      a.validate(value);
      return {state: value, revision: r.revision};
    }
    function error(e) {
      lastError = true;
      const text = e.message === 'key' ? 'Ключ не подходит. Подключите облако заново.' :
        e.message === 'size' ? 'Данных слишком много для облака. Скачайте резервную копию.' :
        e.message === 'format' ? 'Облако вернуло неверные данные. Автозапись остановлена.' :
        dirty ? 'Нет связи с облаком — изменения пока только в этом браузере.' :
        base ? 'Нет связи с облаком — показана сохранённая копия.' : 'Не удалось загрузить облако. Отметки пока заблокированы.';
      // A bad key/schema must not cause continued writes against an unknown state.
      if (e.message === 'key' || e.message === 'format') blocked = true;
      status(text, 'error', true);
    }
    function acceptRemote(r) {
      base = clone(r.state); revision = r.revision;
      apply(r.state); dirty = false; blocked = false; lastError = false;
      persist(); status('Облако: синхронизировано');
    }
    async function initialize() {
      if (!config || busy) return;
      busy = true; blocked = true;
      status('Подключаем облако…');
      try {
        let meta = null;
        try {
          meta = JSON.parse(localStorage.getItem(META_KEY) || 'null');
          if (meta && meta.version === 1 && meta.endpoint === config.endpoint &&
              Number.isSafeInteger(meta.revision) && meta.revision >= 0) {
            a.validate(meta.base); a.validate(meta.snapshot);
            base = clone(meta.base); revision = meta.revision;
            // The metadata snapshot is atomic, unlike two independently written localStorage keys.
            // If KEY differs, retain that local copy too rather than silently dropping it.
            const current = a.read();
            if (same(current, meta.base) && meta.dirty) apply(meta.snapshot);
            dirty = !same(a.read(), base);
          }
        } catch (_) { base = null; }
        const r = await remoteState();
        initialized = true; blocked = false; lastError = false;
        if (base !== null) {
          dirty = !same(a.read(), base);
          if (!dirty) acceptRemote(r);
          else { status('Отправляем сохранённые изменения…'); persist(); }
          return;
        }
        const local = clone(a.read());
        if (!meaningful(local) || same(local, r.state)) { acceptRemote(r); return; }
        backup(local);
        choice('migration', 'Перенос отметок в облако',
          `В этом браузере опубликовано: ${count(local)}. В облаке: ${count(r.state)}. ` +
          'Локальная резервная копия сохранена. Выберите источник; ничего не заменяется автоматически.', [
          [meaningful(r.state) ? 'Использовать облачные отметки' : 'Начать с пустого облака', async () => {
            // A fresh read avoids adopting an already stale server version.
            hideChoice(); busy = true;
            try { acceptRemote(await remoteState()); } catch (e) { blocked = true; error(e); }
            finally { busy = false; }
          }],
          [meaningful(r.state) ? 'Объединить с облаком' : 'Перенести отметки этого браузера', () => {
            hideChoice(); base = meaningful(r.state) ? empty() : clone(r.state); revision = r.revision;
            // With existing cloud data, merge additions against an empty baseline.
            // Overlapping records require an explicit conflict decision; never wipe the cloud.
            dirty = true; blocked = false; persist(); schedule(0);
          }],
          ['Пока не подключать', disconnect]
        ]);
      } catch (e) {
        initialized = true;
        // With a confirmed baseline, offline edits can be queued without losing their origin.
        blocked = base === null;
        error(e);
      } finally {
        busy = false;
        if (dirty && !paused && !blocked && !lastError) schedule(0);
      }
    }
    function schedule(ms = 400) {
      clearTimeout(timer);
      timer = setTimeout(() => sync(), ms);
    }
    async function sync() {
      if (!config || busy || blocked || paused || !initialized || !alive) return;
      busy = true; clearTimeout(timer);
      status(dirty ? 'Сохраняем в облако…' : 'Проверяем облако…');
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const r = await remoteState();
          if (!dirty) { acceptRemote(r); return; }
          const local = clone(a.read());
          const preference = decision?.revision === r.revision ? decision.preference : null;
          const m = merge(base, local, r.state, preference);
          if (m.conflicts.length && !preference) {
            const conflictRevision = r.revision;
            choice('conflict', 'Один и тот же пост изменён в двух браузерах',
              `Конфликт: ${m.conflicts.join(', ')}. Автозапись приостановлена. ` +
              'Изменения других постов будут объединены. Выберите вариант для конфликтующих записей.', [
              ['Сохранить мои изменения', () => {
                backup(a.read()); decision = {revision: conflictRevision, preference: 'local'};
                hideChoice(); schedule(0);
              }],
              ['Принять облачный вариант', () => {
                backup(a.read()); decision = {revision: conflictRevision, preference: 'remote'};
                hideChoice(); schedule(0);
              }]
            ]);
            persist(); return;
          }
          a.validate(m.state);
          const body = {op: 'put', expectedRevision: r.revision, state: m.state};
          if (new TextEncoder().encode(JSON.stringify(body)).length > 500000) throw Error('size');
          const saved = await request(body);
          if (saved.conflict) { decision = null; continue; }
          if (!Number.isSafeInteger(saved.revision) || saved.revision !== r.revision + 1) throw Error('format');
          // Keep edits made while the request was in flight; never replace them with the sent snapshot.
          const newer = clone(a.read()), rebase = merge(local, newer, m.state, 'local');
          base = clone(m.state); revision = saved.revision; decision = null;
          apply(rebase.state); dirty = !same(rebase.state, base); lastError = false;
          persist(); status(dirty ? 'Сохраняем следующие изменения…' : 'Облако: синхронизировано');
          return;
        }
        throw Error('busy_cloud');
      } catch (e) { if (alive) error(e); }
      finally {
        busy = false;
        if (dirty && !paused && !blocked && !lastError) schedule(250);
      }
    }
    function changed() {
      if (!config || !alive) return;
      dirty = base === null || !same(a.read(), base);
      persist();
      status('Есть изменения — ожидают сохранения в облаке.', lastError ? 'error' : 'warning', lastError);
      if (!paused && !blocked) { lastError = false; schedule(); }
    }
    function disconnect() {
      if (dirty && !confirm('Есть изменения, ещё не сохранённые в облаке. Они останутся только в этом браузере. Отключить облако?')) return;
      alive = false; config = null; invalidConfig = false; blocked = false; dirty = false;
      clearTimeout(timer); hideChoice();
      try { localStorage.removeItem(CONFIG_KEY); localStorage.removeItem(META_KEY); } catch (_) {}
      status(''); a.toast('Облако отключено в этом браузере. Локальные отметки сохранены.');
      $('storageNote').textContent = 'Облако не подключено. Отметки сохраняются только в этом браузере.';
    }
    $('cloudRetry').onclick = () => {
      blocked = false; lastError = false;
      if (base === null) initialize(); else sync();
    };
    $('cloudDisconnect').onclick = () => { if (!busy) disconnect(); else a.toast('Дождитесь завершения текущего запроса.'); };
    $('cloudBackup').onclick = () => {
      try {
        const b = JSON.parse(localStorage.getItem(BACKUP_KEY));
        a.download('threads-desk-before-cloud.json', JSON.stringify(b.state, null, 2), 'application/json');
      } catch (_) { a.toast('Резервная копия недоступна.'); }
    };
    $('cloudShare').onclick = async () => {
      if (!config || !confirm('Эта ссылка содержит секретный ключ. Передавайте её только себе для подключения другого браузера. Не отправляйте её в чат или другим людям. Скопировать?')) return;
      const url = new URL('cloud-connect.html', location.href);
      url.hash = new URLSearchParams({endpoint: config.endpoint, key: config.key}).toString();
      try { await navigator.clipboard.writeText(url.href); a.toast('Приватная ссылка скопирована. Откройте её в другом браузере.'); }
      catch (_) { a.toast('Буфер обмена недоступен. Используйте исходную приватную ссылку из Cloud Shell.'); }
    };
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (validConfig(parsed)) config = parsed; else invalidConfig = true;
      }
    } catch (_) { invalidConfig = true; }
    if (config) {
      status('Подключаем облако…');
      $('storageNote').textContent = 'Подключено облачное хранение. Ключ сохранён только в этом браузере и не включается в резервные копии. При ошибке связи изменения ждут отправки локально.';
    } else if (invalidConfig) {
      blocked = true;
      status('Неверная настройка облака. Подключите заново или отключите.', 'error');
    } else status('');
    window.addEventListener('online', () => { if (config) { lastError = false; blocked = false; base ? sync() : initialize(); } });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && config && !paused) { lastError = false; base ? sync() : initialize(); }
    });
    // Fetch only while this page is visible; no background worker or tight polling loop.
    setInterval(() => { if (!document.hidden && config && !paused && !blocked) sync(); }, 30000);
    window.addEventListener('beforeunload', e => {
      if (config && dirty) { e.preventDefault(); e.returnValue = ''; }
    });
    return {init: initialize, changed,
      canEdit: () => !config && !invalidConfig || initialized && !blocked && !paused,
      isConnected: () => !!config};
  }
  window.ThreadsCloud = {create, merge, validConfig, CONFIG_KEY, ENDPOINT};
})();
