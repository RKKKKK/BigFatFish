(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleQuotaPresentation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // How the pet words the quota book: the bars under it, the overview of every
  // account, and the state its bubbles read. Pure functions of the book's data.
  const DAY = 86400000;
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = value => Math.max(0, Math.min(100, value));
  const level = percent => percent < 20 ? 'low' : percent < 50 ? 'warn' : 'ok';
  const pad = value => String(value).padStart(2, '0');

  // A moment as the pet says it: a time today, tomorrow, a weekday within the
  // week, else a date.
  function moment(value, now) {
    const at = new Date(typeof value === 'number' ? value : Date.parse(value));
    if (!Number.isFinite(at.getTime())) return '';
    const time = at.getHours() + ':' + pad(at.getMinutes()), today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const days = Math.floor((at.getTime() - today.getTime()) / DAY);
    if (days === 0) return time;
    if (days === 1) return '明天 ' + time;
    if (days > 1 && days < 7) return WEEKDAYS[at.getDay()] + ' ' + time;
    return (at.getMonth() + 1) + '月' + at.getDate() + '日 ' + time;
  }
  function current(snapshot) {
    const accounts = snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    return accounts.find(account => account.id === snapshot.current) || null;
  }
  function uses(account) {
    const parts = [];
    if (account.uses.some(use => use.startsWith('codex:'))) parts.push('Codex API');
    if (account.uses.includes('pet')) parts.push('大肥鱼');
    return parts.join(' · ');
  }
  // The heading of an account, such as "Codex 订阅 · Plus" or "labkey · Codex API".
  function title(account) {
    if (account.type === 'subscription') return account.name + ' 订阅' + (account.plan ? ' · ' + account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : '');
    return account.name + (uses(account) ? ' · ' + uses(account) : '');
  }
  // What the pet's bubble calls the current quota.
  function label(account) {
    if (!account) return '额度';
    if (account.type === 'subscription') return account.name + ' 订阅额度';
    return account.name + (account.windows.length ? ' 额度' : ' 余额');
  }
  function meter(name, percent, value) {
    const share = clamp(percent);
    return { label: name, percent: share, level: level(share), ...(value === undefined ? {} : { value }) };
  }
  // The bars under the pet: each valid subscription window with the share
  // left, or an API account's first quota or its balance against the full
  // balance, with the amount left in money when a formatter is given.
  function meters(account, { formatMoney } = {}) {
    if (!account) return [];
    const money = (amount, currency) => formatMoney ? formatMoney(amount, currency) : undefined;
    const windows = account.windows.filter(window => !window.reset && finite(window.remainingPercent));
    if (account.type === 'subscription') return windows.map(window => meter(window.label, window.remainingPercent, Math.round(window.remainingPercent) + '%'));
    if (windows.length) return [meter(windows[0].label, windows[0].remainingPercent, money(windows[0].remaining, windows[0].currency))];
    const balance = account.balance;
    return balance && !balance.unlimited && finite(balance.amount) && balance.full > 0 ? [meter('余额', balance.amount / balance.full * 100, money(balance.amount, balance.currency))] : [];
  }
  // One line per quota in the overview: its bar, what is left and when it resets.
  function rows(account, { formatMoney, now = Date.now() }) {
    const result = [];
    for (const window of account.windows) {
      if (window.reset) { result.push({ label: window.label, percent: null, level: 'ok', value: '已重置', note: '' }); continue; }
      const percent = clamp(window.remainingPercent);
      const value = finite(window.limit) ? '剩 ' + formatMoney(window.remaining, window.currency) + ' / ' + formatMoney(window.limit, window.currency) : Math.round(percent) + '%';
      const notes = [window.resetsAt ? moment(window.resetsAt, now) + ' 重置' : '', window.safe ? '安全额度 ' + formatMoney(window.safe, window.currency) : ''];
      result.push({ label: window.label, percent, level: level(percent), value, note: notes.filter(Boolean).join(' · ') });
    }
    const balance = account.balance;
    if (balance && balance.unlimited) result.push({ label: '余额', percent: null, level: 'ok', value: '不限额', note: '' });
    else if (balance && finite(balance.amount)) {
      const percent = balance.full > 0 ? clamp(balance.amount / balance.full * 100) : null;
      result.push({ label: '余额', percent, level: percent === null ? 'ok' : level(percent), value: formatMoney(balance.amount, balance.currency),
        note: balance.safe ? '安全额度 ' + formatMoney(balance.safe, balance.currency) : '' });
    }
    return result;
  }
  // One sentence on today's spend and how long the quota lasts at this rate;
  // without today's spend where the page shows it apart.
  function paceText(account, { formatMoney, now = Date.now(), today = true }) {
    if (account.type === 'subscription') {
      const paced = account.windows.filter(window => window.pace);
      const first = paced.filter(window => window.pace.exhaustAt).sort((a, b) => a.pace.exhaustAt - b.pace.exhaustAt)[0];
      if (first) return first.pace.exhaustAt <= now ? '按这个速度，' + first.label + ' 额度可能已经用完' :
        '按这个速度，' + first.label + ' 额度约 ' + moment(first.pace.exhaustAt, now) + ' 用完';
      return paced.length ? '按这个速度，重置前够用' : '';
    }
    const parts = [], spend = account.spend, average = spend && spend.average, pace = account.pace;
    if (today && spend && finite(spend.today)) parts.push('今日 ' + formatMoney(spend.today, spend.currency));
    if (average && average.amount === 0) parts.push('近 ' + average.days + ' 天没有消费');
    else if (average && pace) {
      const lead = '按近 ' + average.days + ' 天日均 ' + formatMoney(average.amount, average.currency);
      if (pace.enough === true) parts.push(lead + '，重置前够用');
      else if (pace.exhaustAt) parts.push(lead + '，约 ' + moment(pace.exhaustAt, now) + ' 用完' + (pace.enough === false ? '，早于重置' : ''));
      else if (finite(pace.daysLeft)) parts.push(lead + '，约可用 ' + Math.max(1, Math.round(pace.daysLeft)) + ' 天');
    }
    return parts.join(' · ');
  }
  // Why an account shows nothing yet, if it does not.
  function status(account) {
    if (account.error) return (account.stale ? '上次成功数据 · ' : '') + account.error;
    if (account.available) return '';
    if (account.provider === 'claude') return '等 Claude 下次回复后更新';
    if (account.provider === 'codex') return '等 Codex 下次在订阅上运行后更新';
    return '正在查询…';
  }
  // The accounts worth listing: those with quota to show, with a problem, or in use.
  function overview(snapshot) {
    const accounts = snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    return accounts.filter(account => account.available || account.error || account.id === snapshot.current);
  }
  // The current account in the shape the pet's bubbles read.
  function bubbleState(account) {
    const empty = { subscription: null, balance: null, balanceText: '', todayUsage: null, quota: null, balanceFull: null, unlimited: false,
      providerName: '', balanceScope: '', stale: false, status: 'ok', message: '' };
    if (!account) return { ...empty, status: 'loading' };
    if (account.type === 'subscription') {
      const window = id => {
        const value = account.windows.find(item => item.id === id);
        return !value ? null : value.reset ? { reset: true } : { usedPercent: value.usedPercent, remainingPercent: value.remainingPercent, resetsAt: value.resetsAt };
      };
      return { ...empty, subscription: account.available ? { provider: account.provider === 'claude' ? 'Claude' : 'Codex', planType: account.plan,
        observedAt: account.observedAt, fiveHour: window('5h'), sevenDay: window('7d') } : null,
        status: account.available ? 'ok' : 'error', message: account.available ? '' : status(account) };
    }
    if (!account.available) return { ...empty, providerName: account.name, status: account.error ? 'error' : 'loading', message: status(account) };
    const window = account.windows[0], balance = account.balance;
    return { ...empty, providerName: account.name, stale: !!account.stale,
      currency: window && window.currency || balance && balance.currency || account.spend && account.spend.currency || 'USD',
      balance: window ? window.remaining : !balance ? null : balance.unlimited ? Infinity : balance.amount,
      todayUsage: account.spend && finite(account.spend.today) ? account.spend.today : null, unlimited: !!(balance && balance.unlimited),
      quota: window ? { used: window.used, limit: window.limit } : null, balanceFull: balance && balance.full || null };
  }
  return Object.freeze({ moment, current, title, label, meters, rows, paceText, status, overview, bubbleState });
});
