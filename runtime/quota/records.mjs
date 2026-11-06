import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from '../paths.mjs';

// The 记录 page's facts: what an account spent each day and on what, and the
// latest Codex turns on the subscription with the quota left after each.
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Today and the days before it, newest first, as ledger day keys.
function recentDays(now, count) {
  return Array.from({ length: count }, (_, index) => { const day = new Date(now); day.setDate(day.getDate() - index); return dayKey(day); });
}
const sum = values => { const known = values.filter(finite); return known.length ? known.reduce((total, value) => total + value, 0) : null; };
const modelOf = event => Object.keys(event.byModel || {}).join(' + ') || String(event.model || '').split(' · ')[0] || '未知模型';

// One API account: its days for the last month, split between Codex and the
// pet where both use it, and its latest uses. A day's total is the service's
// own record when the query link reports one, else what the pet observed;
// the pet's share comes from its chat billing estimates.
export function apiRecords({ account, ledger, result, requests = [], now = Date.now(), limit = 100 }) {
  const currency = result?.currency || account.context.setting.currency;
  const observed = new Map(), events = [];
  for (const id of account.ledgers) {
    let loaded;
    try { loaded = ledger.load(id + '-' + currency); } catch { continue; }
    const records = ledger.records(id + '-' + currency, now);
    for (const day of records.all.days) if (finite(day.total)) observed.set(day.date, (observed.get(day.date) || 0) + day.total);
    for (const event of loaded.events || []) {
      if (event.isSubagent || !finite(event.ts)) continue;
      const amount = finite(event.cost) ? event.cost : finite(event.amount) ? event.amount : null;
      events.push({ at: event.ts, kind: 'codex', model: modelOf(event), tokens: finite(event.tokens) ? event.tokens : null,
        amount: ['unknown', 'pending'].includes(event.costState) ? null : amount, currency: event.currency || currency,
        state: event.costState || 'unknown', outcome: event.outcome || 'completed' });
    }
  }
  const reported = new Map((result?.dailyUsage || []).map(day => [day.date, day.cost]));
  const usedByCodex = account.uses.some(use => use.startsWith('codex:')), usedByPet = account.uses.includes('pet');
  const petDays = new Map(), firstPet = requests.reduce((first, request) => Math.min(first, request.at), Infinity);
  for (const request of requests) {
    events.push({ ...request, kind: 'pet' });
    if (finite(request.amount)) petDays.set(dayKey(request.at), (petDays.get(dayKey(request.at)) || 0) + request.amount);
  }
  const days = recentDays(now, 30).map(date => {
    const pet = usedByPet && finite(firstPet) && date >= dayKey(firstPet) ? petDays.get(date) || 0 : null;
    let total = reported.has(date) ? reported.get(date) : observed.has(date) ? observed.get(date) : null, estimated = false;
    if (total === null && pet !== null && !usedByCodex) { total = pet; estimated = true; }
    return { date, total, estimated, pet, codex: !usedByCodex ? null : !usedByPet ? total : total !== null && pet !== null ? Math.max(0, total - pet) : null };
  });
  const today = finite(result?.todayUsage) ? result.todayUsage : days[0].total;
  return { currency, today, days7: sum([today, ...days.slice(1, 7).map(day => day.total)]), days30: sum([today, ...days.slice(1).map(day => day.total)]),
    split: usedByCodex && usedByPet, days, events: events.sort((a, b) => b.at - a.at).slice(0, limit) };
}

// The latest Codex turns on the subscription, each with the quota it left.
export function subscriptionTurns({ dataDir, ledger, limit = 30 }) {
  let names = [];
  try { names = fs.readdirSync(path.join(dataDir, 'ledgers')).filter(name => /^[a-f0-9]{24}-[A-Z]{3}\.json$/.test(name)); } catch {}
  const turns = [];
  for (const name of names) {
    let loaded;
    try { loaded = ledger.load(name.slice(0, -5)); } catch { continue; }
    for (const event of loaded.events || []) {
      const limits = event.subscriptionRateLimits;
      if (event.isSubagent || !limits || !finite(event.ts)) continue;
      turns.push({ at: event.ts, model: modelOf(event), tokens: finite(event.tokens) ? event.tokens : null, outcome: event.outcome || 'completed',
        fiveHour: finite(limits.fiveHour?.remainingPercent) ? limits.fiveHour.remainingPercent : null,
        sevenDay: finite(limits.sevenDay?.remainingPercent) ? limits.sevenDay.remainingPercent : null });
    }
  }
  return turns.sort((a, b) => b.at - a.at).slice(0, limit);
}
