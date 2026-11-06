(function (host) {
  'use strict';
  const DECIMALS = new Intl.NumberFormat('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const supported = value => value === 'USD' || value === 'CNY';
  const symbolOf = currency => currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency;
  const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(time(value + 'T00:00:00.000Z')) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;

  // Amounts show in one chosen currency, converted with a dated rate; with no
  // choice, or where no rate converts an amount, it shows in its own currency,
  // so one account's currency never changes how another's amounts read.
  function createMoneyState({ loadQuote, readPreference = () => null, savePreference = () => {}, now = Date.now } = {}) {
    let saved;
    try { saved = readPreference(); } catch {}
    let displayCurrency = supported(saved) ? saved : null;
    let quote = null, latestQuote = null, quoteJob = null, forceUpgrade = null, requestSerial = 0, error = '';
    let checkedAt = null, cooldownUntil = 0, retryUntil = 0;
    const listeners = new Set(), bindings = new Map();
    const snapshot = value => value && Object.freeze({ ...value });
    const pendingQuote = () => !!latestQuote && (!quote || latestQuote.usdCny !== quote.usdCny || latestQuote.date !== quote.date);
    function state() {
      return Object.freeze({ displayCurrency, quote: snapshot(quote), latestQuote: snapshot(latestQuote),
        hasPendingQuote: pendingQuote(), checkedAt, cooldownRemainingMs: Math.max(0, cooldownUntil - now()),
        retryAfterMs: Math.max(0, retryUntil - now()), refreshing: !!quoteJob || !!forceUpgrade,
        stale: !!latestQuote?.stale || !!error, error });
    }
    function refreshBindings(scope) {
      for (const [element, binding] of bindings) {
        if (!scope || element === scope || scope.contains(element)) binding.write(binding.read());
      }
    }
    function emit(updateBindings = true) {
      if (updateBindings) refreshBindings();
      const current = state();
      for (const listener of listeners) { try { listener(current); } catch {} }
    }
    function setResponseMetadata(value, failed = false) {
      checkedAt = Number.isFinite(time(value?.checkedAt)) ? value.checkedAt :
        !failed && Number.isFinite(time(value?.retrievedAt)) ? value.retrievedAt : new Date(now()).toISOString();
      cooldownUntil = now() + Math.max(0, Number(value?.cooldownRemainingMs) || 0);
      retryUntil = now() + Math.max(0, Number(value?.retryAfterMs) || 0);
    }
    function acceptQuote(value) {
      if (!value || !Number.isFinite(value.usdCny) || value.usdCny <= 0 || value.usdCny >= 1e6 ||
        !validDate(value.date) || !Number.isFinite(time(value.retrievedAt))) throw new Error('汇率数据无效');
      latestQuote = Object.freeze({ ...value });
      setResponseMetadata(value);
      error = value.stale ? '本次未取得更新报价，保留已验证的缓存汇率。' : '';
      emit(false);
      return latestQuote;
    }
    function startQuoteRequest({ force, reason }) {
      const job = { force, serial: ++requestSerial, promise: null };
      quoteJob = job;
      job.promise = Promise.resolve().then(() => loadQuote({ force, reason })).then(acceptQuote).catch(failure => {
        error = failure?.message || '汇率暂不可用，已保留当前显示。';
        setResponseMetadata(failure, true);
        if (latestQuote) latestQuote = Object.freeze({ ...latestQuote, stale: true, checkedAt });
        emit(false); throw failure;
      }).finally(() => {
        if (quoteJob === job) quoteJob = null;
        emit(false);
      });
      emit(false); return job.promise;
    }
    function getQuote({ force = false, reason = 'request' } = {}) {
      if (forceUpgrade) return forceUpgrade.promise;
      if (quoteJob) {
        if (!force || quoteJob.force) return quoteJob.promise;
        // A force click behind a normal read must still make one real forced read.
        const previous = quoteJob.promise, upgrade = { promise: null };
        forceUpgrade = upgrade;
        upgrade.promise = previous.catch(() => null).then(() => startQuoteRequest({ force: true, reason })).finally(() => {
          if (forceUpgrade === upgrade) forceUpgrade = null;
          emit(false);
        });
        emit(false); return upgrade.promise;
      }
      return startQuoteRequest({ force, reason });
    }
    function applyLatestQuote({ refreshBindings: updateBindings = true } = {}) {
      if (latestQuote) quote = latestQuote;
      emit(updateBindings);
      return !!quote;
    }
    async function refreshQuote({ force = false, apply = false, reason = 'request' } = {}) {
      try {
        const value = await getQuote({ force, reason });
        // The first rate is used as soon as it comes; a newer one waits until asked for.
        if (apply || !quote) applyLatestQuote();
        return !value.stale;
      } catch {
        // A failed background/manual check never erases an already displayed rate.
        return false;
      }
    }
    // An amount in the display currency, or null where no rate converts it.
    function convert(value, from) {
      if (!displayCurrency || from === displayCurrency) return value;
      if (!supported(from) || !quote) return null;
      return from === 'USD' ? value * quote.usdCny : value / quote.usdCny;
    }
    // In the display currency where a rate converts it, else in its own; '--'
    // when the amount or its currency is not known.
    function formatMoney(amount, currency, space = false) {
      if (amount === Infinity) return '不限额';
      const value = Number(amount), from = typeof currency === 'string' ? currency.toUpperCase() : '';
      if (amount == null || !Number.isFinite(value) || !from) return '--';
      const converted = convert(value, from), shown = converted === null ? value : converted;
      const symbol = symbolOf(converted === null ? from : displayCurrency || from);
      return symbol + (space || symbol.length > 1 ? ' ' : '') + DECIMALS.format(Object.is(shown, -0) ? 0 : shown);
    }
    function fresh(value) {
      const age = value ? now() - time(value.retrievedAt) : Infinity;
      return !!value && !value.stale && age >= 0 && age < 6 * 60 * 60 * 1000;
    }
    // USD or CNY converts every amount a rate can convert; none shows each in
    // its own. Resolves false only while this choice still waits for a first
    // rate; until one comes, amounts show in their own currencies.
    async function setDisplayCurrency(currency) {
      const next = currency ? String(currency).toUpperCase() : null;
      if (next && !supported(next)) throw new Error('显示换算目前支持 USD 和 CNY');
      displayCurrency = next;
      try { savePreference(next || ''); } catch {}
      applyLatestQuote();
      if (!next) return true;
      if (!quote) { await refreshQuote({ reason: 'currency' }); return !!quote || displayCurrency !== next; }
      if (!fresh(quote)) getQuote({ reason: 'currency' }).catch(() => {});
      return true;
    }
    async function ready() {
      try {
        await getQuote({ reason: 'startup' });
        applyLatestQuote(); return true;
      } catch { return false; }
    }
    function bind(element, read, write = value => { element.textContent = value; }) {
      bindings.set(element, { read, write }); write(read()); return () => bindings.delete(element);
    }
    function clearBindings(root) {
      for (const element of bindings.keys()) if (element === root || root.contains(element)) bindings.delete(element);
    }
    function pruneBindings() { for (const element of bindings.keys()) if (!element.isConnected) bindings.delete(element); }
    function onChange(listener) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); }
    return Object.freeze({ state, formatMoney, setDisplayCurrency,
      ready, refreshQuote, applyLatestQuote, bind, clearBindings, pruneBindings, refreshBindings, onChange });
  }

  if (typeof module === 'object' && module.exports) module.exports = { createMoneyState };
  else {
    const money = createMoneyState({
      readPreference: () => { try { return localStorage.getItem('dshw-display-currency'); } catch { return null; } },
      savePreference: value => { try { localStorage.setItem('dshw-display-currency', value); } catch {} },
      loadQuote: async ({ force = false, reason = 'request' } = {}) => {
        const query = [];
        if (force) query.push('refresh=1');
        const cause = force && reason === 'request' ? 'manual' : reason;
        if (cause !== 'request') query.push('reason=' + encodeURIComponent(cause));
        const response = await fetch('/api/fx/usd-cny' + (query.length ? '?' + query.join('&') : ''), { cache: 'no-store' });
        const value = await response.json();
        if (!response.ok || !value.ok) {
          const error = new Error(value.error || '汇率暂不可用，换算不了的金额先按各自的币种显示');
          for (const key of ['checkedAt', 'cooldownRemainingMs', 'retryAfterMs']) if (value[key] !== undefined) error[key] = value[key];
          throw error;
        }
        return value;
      },
    });
    host.WhaleMoney = money;
    const observer = new MutationObserver(() => money.pruneBindings());
    observer.observe(document.body, { childList: true, subtree: true });
    const periodic = setInterval(() => money.refreshQuote({ apply: false, reason: 'timer' }), 60000);
    const online = () => money.refreshQuote({ apply: false, reason: 'online' });
    const visible = () => { if (!document.hidden) money.refreshQuote({ apply: false, reason: 'visibility' }); };
    host.addEventListener?.('online', online);
    document.addEventListener('visibilitychange', visible);
    host.addEventListener?.('pagehide', () => {
      clearInterval(periodic); observer.disconnect();
      host.removeEventListener?.('online', online); document.removeEventListener('visibilitychange', visible);
    }, { once: true });
    money.ready();
  }
})(globalThis);
