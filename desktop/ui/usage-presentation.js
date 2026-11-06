(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleUsagePresentation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // A subscription shows while any of its windows is valid; a window that has
  // reset says so instead of a share.
  function hasSubscription(value) {
    return !!(value && value.available !== false && [value.fiveHour, value.sevenDay].some(window =>
      window && !window.reset && Number.isFinite(Number(window.remainingPercent))));
  }
  const WINDOWS = [['5小时', 'fiveHour', false], ['7天', 'sevenDay', true]];
  function quotaResetTime(window, includeDate = false) {
    const ms = Date.parse(window?.resetsAt || '');
    if (!Number.isFinite(ms)) return '';
    return new Intl.DateTimeFormat('zh-CN', { ...(includeDate ? { month: 'numeric', day: 'numeric' } : {}),
      hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  }
  // The windows side by side in the bubble: the share left of each, or that it
  // has reset. A window the subscription does not report is left out.
  function quotaStats(value) {
    return WINDOWS.filter(([, key]) => value?.[key]).map(([name, key]) => {
      const window = value[key];
      if (window.reset) return { name, value: '已重置', level: 'ok' };
      const percent = Number(window.remainingPercent);
      if (!Number.isFinite(percent)) return { name: name + '剩余', value: '--', level: 'ok' };
      const share = Math.max(0, Math.min(100, Math.round(percent)));
      return { name: name + '剩余', value: share + '%', level: share < 20 ? 'low' : share < 50 ? 'warn' : 'ok' };
    });
  }
  // When each window still counting resets.
  function quotaResets(value) {
    return WINDOWS.map(([name, key, includeDate]) => {
      const window = value?.[key], time = window && !window.reset ? quotaResetTime(window, includeDate) : '';
      return time ? name + ' ' + time + ' 重置' : '';
    }).filter(Boolean);
  }
  function hasBalance(value) {
    return !!value?.balanceText || value?.balance !== null && value?.balance !== undefined;
  }
  function balanceAmount(value, formatMoney) {
    return value.balanceText || (!hasBalance(value) ? value.status === 'error' ? '--' : '…' : formatMoney(value.balance, value.currency || 'USD'));
  }
  function spentToday(value, formatMoney) {
    return '今日 ' + (value.todayUsage != null ? formatMoney(value.todayUsage, value.currency || 'USD') : '--');
  }
  function balanceBubble(value, { formatMoney } = {}) {
    return { amount: balanceAmount(value, formatMoney),
      hint: value.status === 'error' ? (value.message || '获取失败 · 点击重试').slice(0, 20) : !hasBalance(value) ? '加载中…' :
        spentToday(value, formatMoney) };
  }
  function taskBubble(notice, formatMoney) {
    if (hasSubscription(notice.subscriptionRateLimits)) return { kind: 'subscription',
      heading: notice.completionKind === 'failed' ? 'Codex 任务未成功' : notice.completionKind === 'cancelled' ? 'Codex 任务已暂停' : 'Codex 任务完成' };
    return { kind: 'cost', label: notice.label, note: notice.note,
      amount: notice.amount === null ? notice.costState === 'pending' ? '待记账' : '金额未知' : formatMoney(notice.amount, notice.currency),
      hint: (notice.tokens == null ? '' : notice.tokens.toLocaleString('en-US') + ' tokens · ') +
        (notice.costState === 'pending' ? '等待账单确认' : notice.costState === 'unknown' ? '以服务商账单为准' :
          notice.costState === 'estimated' ? '配置价格估算' : '同密钥区间观测') };
  }
  return Object.freeze({ hasBalance, hasSubscription, quotaStats, quotaResets, balanceBubble, taskBubble });
});
