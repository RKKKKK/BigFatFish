(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleTurnNotice = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // 0.2.0: failure/cancellation no longer uses a separate playful status bubble.
  // The bubble falls back to a neutral cost label, so the observed amount stays
  // visible while the tone stays factual. Restoring the playful copy only
  // requires filling this table again.
  const outcomeLabels = Object.freeze({
    failed: '上一轮期间 API 扣费（未成功）:',
    cancelled: '上一轮期间 API 扣费（已暂停）:',
  });
  function kind(record) {
    if (record.completionKind === 'failed' || record.outcome === 'failed') return 'failed';
    if (record.completionKind === 'cancelled' || ['aborted', 'cancelled'].includes(record.outcome)) return 'cancelled';
    return 'success';
  }
  function shouldNotify(record, { seq = 0, id = '', firstPoll = false, startedAt = 0 } = {}) {
    if (!record?.ok || !Number.isSafeInteger(record.seq) || record.seq <= seq || !record.id || record.id === id ||
        record.turn == null || record.notify === false || record.isSubagent) return false;
    const published = record.notificationAt || record.ts;
    const at = typeof published === 'number' ? published : Date.parse(published);
    return !firstPoll || Number.isFinite(at) && at >= startedAt;
  }
  // The runtime checked the windows; a window that has reset arrives as null.
  function rateWindow(value) {
    const remainingPercent = Number(value?.remainingPercent), usedPercent = Number(value?.usedPercent);
    const resetsAt = typeof value?.resetsAt === 'string' && Number.isFinite(Date.parse(value.resetsAt)) ? value.resetsAt : null;
    if (!Number.isFinite(remainingPercent) || !Number.isFinite(usedPercent) || !resetsAt) return null;
    return Object.freeze({ usedPercent: Math.max(0, Math.min(100, usedPercent)), remainingPercent: Math.max(0, Math.min(100, remainingPercent)),
      windowMinutes: value.windowMinutes, resetsAt });
  }
  function subscriptionRateLimits(value) {
    const fiveHour = rateWindow(value?.fiveHour), sevenDay = rateWindow(value?.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    return Object.freeze({ planType: typeof value.planType === 'string' ? value.planType.slice(0, 64) : '', fiveHour, sevenDay });
  }
  function snapshot(record, nativeCurrency = 'USD') {
    const completionKind = kind(record);
    const known = record.amount !== null && record.amount !== undefined && Number.isFinite(Number(record.amount)) &&
      !['pending', 'unknown'].includes(record.costState);
    return Object.freeze({
      id: String(record.id || ''), completionKind,
      label: String(record.label || outcomeLabels[completionKind] || '上一轮期间 API 扣费:'),
      amount: known ? Number(record.amount) : null,
      currency: record.currency || nativeCurrency,
      costState: known ? record.costState || 'observed' : record.costState === 'pending' ? 'pending' : 'unknown',
      tokens: Number.isFinite(record.tokens) && record.tokens >= 0 ? Math.floor(record.tokens) : null,
      note: String(record.note || ''),
      subscriptionRateLimits: subscriptionRateLimits(record.subscriptionRateLimits),
    });
  }
  function enabled(notice, settings, turnCostOn) {
    return notice.completionKind === 'success' ? !!turnCostOn : settings?.[notice.completionKind] !== false;
  }
  return Object.freeze({ kind, shouldNotify, snapshot, enabled });
});
