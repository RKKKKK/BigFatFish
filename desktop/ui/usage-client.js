(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleUsageClient = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Reads the quota book and the two completion streams for the pet. The book
  // decides which account is shown; this client only reads it, under a
  // deadline, and hands a choice back to it.
  function create({ fetchImpl, shouldNotify, storage, now = Date.now, timeoutMs = 25000 } = {}) {
    const load = key => { try { return storage?.getItem(key) || ''; } catch { return ''; } };
    const save = (key, value) => { try { storage?.setItem(key, value); } catch {} };
    let seq = Number(load('dshw-last-seq') || 0), id = load('dshw-last-turn-id'), aligned = false, codexJob = null;
    let claudeId = load('dshw-last-claude-turn-id'), claudeAligned = false, claudeJob = null, quotaJob = null;
    if (!Number.isFinite(seq) || seq < 0) seq = 0;
    const startedAt = now();

    async function request(url, { signal, method = 'GET', body } = {}) {
      const response = await fetchImpl(url, { cache: 'no-store', signal, method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      return response.json();
    }
    async function deadline(work) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try { return await work(controller.signal); }
      finally { clearTimeout(timer); }
    }
    // Every account and the one in use. Reads made while one is running share
    // it; a manual read first has the runtime query every API account again.
    function quotas({ manual = false } = {}) {
      if (quotaJob && !manual) return quotaJob;
      const job = deadline(signal => request('/api/quotas' + (manual ? '?refresh=1' : ''), { signal })).then(result => {
        if (!result || result.ok === false || !Array.isArray(result.accounts)) throw new Error(result?.error || '额度暂时无法读取');
        return result;
      }).finally(() => { if (quotaJob === job) quotaJob = null; });
      quotaJob = job;
      return job;
    }
    function select(account, at) {
      return request('/api/quotas/current', { method: 'PUT', body: at ? { id: account, at } : { id: account } }).then(result => {
        if (!result || result.ok === false) throw new Error(result?.error || '切换未完成，请重试');
        return result;
      });
    }
    // An older pet kept its own choice of Codex or Claude in the page. It moves
    // to the book once, with the time it was made; a later activity still wins.
    function migrateChoice() {
      if (load('dshw-display-source-migrated')) return Promise.resolve(null);
      save('dshw-display-source-migrated', '1');
      const source = load('dshw-display-source'), at = Number(load('dshw-display-source-manual-at'));
      if (!['codex', 'claude'].includes(source) || !Number.isFinite(at) || at <= 0) return Promise.resolve(null);
      return select(source, at).catch(() => null);
    }
    function pollCodexCompletion() {
      // Only the first caller consumes a completion; joining its result would
      // make each caller independently play the same sound and show a bubble.
      if (codexJob) return Promise.resolve({ record: null, fresh: false });
      codexJob = request('/dsh-whale/last-turn.json').then(record => {
        if (!record?.ok || typeof record.seq !== 'number' || record.seq < seq) return { record: null, fresh: false };
        const fresh = shouldNotify(record, { seq, id, firstPoll: !aligned, startedAt });
        aligned = true; seq = record.seq;
        if (record.id) id = record.id;
        save('dshw-last-seq', String(seq)); save('dshw-last-turn-id', id);
        return { record, fresh };
      }).finally(() => { codexJob = null; });
      return codexJob;
    }
    function pollClaudeCompletion() {
      if (claudeJob) return Promise.resolve({ record: null, fresh: false });
      claudeJob = request('/api/claude/last-turn').then(record => {
        if (!record?.ok || !record.available || !record.id) return { record: null, fresh: false };
        const fresh = record.id !== claudeId && (claudeAligned || record.completedAt >= startedAt);
        claudeAligned = true;
        claudeId = record.id;
        save('dshw-last-claude-turn-id', claudeId);
        return { record, fresh };
      }).finally(() => { claudeJob = null; });
      return claudeJob;
    }
    // Reads both completion streams and passes each new completion once to
    // its handler.
    function pollCompletions({ codex = () => {}, claude = () => {} } = {}) {
      return Promise.allSettled([
        pollCodexCompletion().then(({ record, fresh }) => { if (fresh) codex(record); }),
        pollClaudeCompletion().then(({ record, fresh }) => { if (fresh) claude(record); }),
      ]).then(() => undefined);
    }
    const settings = () => request('/dsh-whale/usage-settings.json');
    function saveSettings(patch) {
      return request('/dsh-whale/usage-settings.json', { method: 'PUT', body: patch || {} }).then(result => {
        if (result?.ok !== true) throw new Error(result?.error || '保存未完成，请重试');
        return result;
      });
    }
    return Object.freeze({ quotas, select, migrateChoice, pollCompletions, settings, saveSettings });
  }
  return Object.freeze({ create });
});
