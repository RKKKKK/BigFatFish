// Quota reminders: a quota window or a balance running low, and a day's spend
// passing its budget. A low reminder fires when its threshold is crossed and
// again only after the quota recovered; a budget fires once a day.
export const ALERT_DEFAULTS = Object.freeze({ on: true, windowPercent: 20, balancePercent: 20, balanceBelow: {}, budgetOn: false, dailyBudget: {} });

function amounts(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [currency, amount] of Object.entries(value)) {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('提醒的币种须使用 USD、CNY 等三位代码');
    if (amount === '' || amount === null || amount === undefined) continue;
    const number = Number(amount);
    if (!Number.isFinite(number) || number < 0 || number > 1e9) throw new Error('提醒金额须为非负数字');
    if (number > 0) result[currency] = number;
  }
  return result;
}
const percent = (value, fallback) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error('提醒百分比须在 0 到 100 之间');
  return number;
};

export function cleanAlertSettings(value = {}) {
  return { on: value.on !== false, windowPercent: percent(value.windowPercent, ALERT_DEFAULTS.windowPercent),
    balancePercent: percent(value.balancePercent, ALERT_DEFAULTS.balancePercent), balanceBelow: amounts(value.balanceBelow),
    budgetOn: value.budgetOn === true, dailyBudget: amounts(value.dailyBudget) };
}

// The old balance warning and daily budget were amounts in the old API
// source's currency; they carry over as amounts in that currency.
export function legacyAlertSettings(saved, currency) {
  const below = Number(saved?.alert?.below), budget = Number(saved?.budget?.amount);
  return cleanAlertSettings({ on: saved?.alert?.on !== false, balanceBelow: below > 0 ? { [currency]: below } : {},
    budgetOn: saved?.budget?.on === true, dailyBudget: budget > 0 ? { [currency]: budget } : {} });
}

const money = (amount, currency) => (currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' ') + amount.toFixed(2);

// Which reminders hold now, and which of them are new. Accounts without data
// keep what they had, so a failed query never fires a reminder again.
export function evaluateAlerts({ accounts, settings, fired = {}, day }) {
  const holding = {}, raised = [];
  const check = (key, low, alert) => {
    if (!low) return;
    holding[key] = true;
    if (!fired[key]) raised.push({ key, ...alert });
  };
  for (const account of accounts) {
    if (!account.available) {
      for (const key of Object.keys(fired)) if (key.startsWith('low:' + account.id + ':')) holding[key] = true;
      continue;
    }
    if (!settings.on) continue;
    for (const window of account.windows) {
      if (window.reset || !Number.isFinite(window.remainingPercent)) continue;
      check('low:' + account.id + ':' + window.id, window.remainingPercent < settings.windowPercent, { accountId: account.id,
        title: account.name + ' ' + window.label + ' 额度不足',
        text: window.safe ? '剩 ' + money(window.remaining, window.currency) + '，安全额度的 ' + Math.round(window.remainingPercent) + '%' :
          '剩余 ' + Math.round(window.remainingPercent) + '%' + (Number.isFinite(window.remaining) ? '（' + money(window.remaining, window.currency) + '）' : '') });
    }
    const balance = account.balance;
    if (balance && !balance.unlimited && Number.isFinite(balance.amount)) {
      const share = balance.full > 0 ? balance.amount / balance.full * 100 : null, floor = settings.balanceBelow[balance.currency];
      check('low:' + account.id + ':balance', share !== null && share < settings.balancePercent || floor > 0 && balance.amount < floor, { accountId: account.id,
        title: account.name + ' 余额不足', text: '余额 ' + money(balance.amount, balance.currency) + (share !== null ? '，' + (balance.safe ? '安全额度' : '满格') + '的 ' + Math.round(share) + '%' : '') });
    }
  }
  if (settings.budgetOn) {
    const spent = {};
    for (const account of accounts) if (account.available && Number.isFinite(account.spend?.today)) spent[account.spend.currency] = (spent[account.spend.currency] || 0) + account.spend.today;
    for (const [currency, amount] of Object.entries(spent)) {
      const budget = settings.dailyBudget[currency];
      if (budget > 0) check('budget:' + currency + ':' + day, amount >= budget, { accountId: '', title: '今日消费已超过 ' + money(budget, currency), text: '今天已用 ' + money(amount, currency) });
    }
  }
  return { fired: holding, raised };
}
