import path from 'node:path';
import { readJson, writeJson, dayKey, rounded } from './paths.mjs';

const initialLedger = () => ({ version: 1, date: '', observed: 0, firstObservation: null, lastObservation: null, history: {}, events: [] });
// The full balance is the highest balance since the last top-up. A rise of more
// than this share of it counts as a top-up; a smaller one, such as a refund, does not.
const TOP_UP_SHARE = 0.01;

export class UsageLedger {
  constructor(dataDir) { this.dataDir = dataDir; }
  file(scope) {
    if (!/^[a-f0-9]{24}-[A-Z]{3}$/.test(scope)) throw new Error('记账账户标识无效');
    return path.join(this.dataDir, 'ledgers', scope + '.json');
  }
  load(scope) { return readJson(this.file(scope), initialLedger()); }
  save(scope, ledger) { writeJson(this.file(scope), ledger); }
  rollover(led, now) {
    const today = dayKey(now);
    if (led.date !== today) {
      if (led.date) led.history[led.date] = { total: led.observed, since: led.firstObservation };
      // Keep the last meter reading across midnight. The interval spanning
      // midnight belongs to its observation date; it is not a per-request bill.
      led.date = today; led.observed = 0; led.firstObservation = null;
    }
    return led;
  }
  observe(scope, sample, now = Date.now()) {
    const led = this.rollover(this.load(scope), now);
    const balance = Number.isFinite(sample.totalBalance) ? sample.totalBalance : null;
    const used = Number.isFinite(sample.totalUsed) ? sample.totalUsed : null;
    const last = led.lastObservation;
    let delta = 0;
    const meterKey = typeof sample.meterKey === 'string' && /^[a-f0-9]{64}$/.test(sample.meterKey) ? sample.meterKey : null;
    // A newer reading can legitimately reset to zero. Ordering is handled by
    // the service, while a changed adapter/scale starts a new meter baseline.
    const sameMeter = !!last && (!meterKey || !last.meterKey || last.meterKey === meterKey);
    if (sameMeter) {
      if (used !== null && last.used !== null && used >= last.used) delta = used - last.used;
      else if (used === null && last.used === null && balance !== null && last.balance !== null) delta = Math.max(0, last.balance - balance);
    }
    const full = sameMeter && Number.isFinite(led.fullBalance) ? led.fullBalance : null;
    if (balance !== null && (full === null || balance > full || last.balance !== null && balance - last.balance > full * TOP_UP_SHARE)) led.fullBalance = balance;
    else if (!sameMeter) led.fullBalance = null;
    led.observed = rounded(led.observed + delta);
    led.firstObservation ||= now;
    led.lastObservation = { balance, used, at: now, ...(meterKey ? { meterKey } : {}) };
    this.save(scope, led); return led;
  }
  append(scope, event) {
    const led = this.load(scope);
    if (led.events.some(e => this.sameEvent(e, event))) return false;
    led.events.push({ ...event, day: dayKey(event.ts) });
    led.events = led.events.slice(-8000);
    this.save(scope, led); return true;
  }
  sameEvent(existing, event) {
    return existing.id === event.id || !!(event.sessionId && event.turnId &&
      existing.id?.endsWith(event.sessionId + ':' + event.turnId));
  }
  find(scope, event) { return this.load(scope).events.find(e => this.sameEvent(e, event)) || null; }
  revise(scope, id, patch) {
    const led = this.load(scope), index = led.events.findIndex(e => e.id === id);
    if (index < 0) return null;
    const before = led.events[index];
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(before[key]) === JSON.stringify(value))) return before;
    const next = { ...before, ...patch, id: before.id, ts: before.ts, day: before.day, revision: (before.revision || 0) + 1 };
    led.events[index] = next; this.save(scope, led); return next;
  }
  records(scope, now = Date.now()) {
    const led = this.rollover(this.load(scope), now);
    const today = dayKey(now);
    const modelsFor = day => {
      const models = new Map();
      for (const e of led.events) {
        if (e.day !== day || e.source !== 'configured-pricing-estimate') continue;
        models.set(e.model, (models.get(e.model) || 0) + (e.cost || 0));
      }
      return [...models].map(([model, cost]) => ({ model: model + '（估算）', cost: rounded(cost) })).sort((a, b) => b.cost - a.cost);
    };
    const totalDay = day => day === today ? led.observed : Object.hasOwn(led.history, day) ? Number(led.history[day].total || 0) : null;
    const days7 = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const date = dayKey(d), total = totalDay(date);
      days7.push({ date, total, totalState: total === null ? 'unknown' : 'observed', models: modelsFor(date) });
    }
    const days = [...new Set([today, ...Object.keys(led.history), ...led.events.map(e => e.day)])].sort().reverse();
    const missingSummaryDays = days.filter(date => totalDay(date) === null);
    return { ok: true, today: { total: led.observed, models: modelsFor(today), since: led.firstObservation }, days7,
      fullBalance: Number.isFinite(led.fullBalance) ? led.fullBalance : null,
      total7: rounded(days7.reduce((n, d) => n + (d.total || 0), 0)),
      total7Complete: days7.every(d => d.total !== null),
      all: { days: days.map(date => ({ date, total: totalDay(date), totalState: totalDay(date) === null ? 'unknown' : 'observed', models: modelsFor(date) })),
        total: rounded(days.reduce((n, day) => n + (totalDay(day) || 0), 0)), totalComplete: missingSummaryDays.length === 0,
        missingSummaryDays, events: led.events.slice(-500).reverse(), storedEventCount: led.events.length, detailLimit: 500 },
      usageSource: 'observed-api-debits', note: '每日合计来自同密钥累计消耗或余额差值；停机或跨午夜的观测间隔归入再次观测日，不能拆成精确逐请求账单。日汇总长期保留，明细最多保留 8000 条、页面提供最近 500 条。旧版已删除的日汇总显示未知，不冒充零消费；模型金额为配置价格估算。' };
  }
}

export function usageDefaults() {
  return {
    taskEnd: { on: false, sel: '' },
    approvalSound: { on: true, sel: 'preset:fx1:release' },
    pomodoroSound: { on: true, sel: 'preset:fx1:release' },
    outcomeNotice: { failed: true, cancelled: true },
    // The old balance warning and daily budget: only carried over into quotaAlerts.
    alert: { on: true, below: 5 },
    budget: { on: true, amount: 10 },
  };
}
