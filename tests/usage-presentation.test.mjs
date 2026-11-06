import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const presentation = browserModule('usage-presentation.js');
const time = (at, includeDate) => new Intl.DateTimeFormat('zh-CN', { ...(includeDate ? { month: 'numeric', day: 'numeric' } : {}),
  hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));

test('a subscription shows its windows side by side with when each resets; a reset window says so', () => {
  const quota = { planType: 'plus', fiveHour: { remainingPercent: 74.6, resetsAt: '2026-09-26T12:00:00Z' },
    sevenDay: { remainingPercent: 40, resetsAt: '2026-10-01T12:00:00Z' } };
  assert.deepEqual([...presentation.quotaStats(quota)].map(stat => ({ ...stat })), [
    { name: '5小时剩余', value: '75%', level: 'ok' }, { name: '7天剩余', value: '40%', level: 'warn' }]);
  assert.deepEqual([...presentation.quotaResets(quota)], ['5小时 ' + time('2026-09-26T12:00:00Z') + ' 重置', '7天 ' + time('2026-10-01T12:00:00Z', true) + ' 重置']);
  const reset = { ...quota, fiveHour: { reset: true } };
  assert.equal(presentation.hasSubscription(reset), true);
  assert.deepEqual([...presentation.quotaStats(reset)].map(stat => stat.name + stat.value), ['5小时已重置', '7天剩余40%']);
  assert.deepEqual([...presentation.quotaResets(reset)], ['7天 ' + time('2026-10-01T12:00:00Z', true) + ' 重置'], 'a reset window has no reset time');
  assert.equal(presentation.quotaStats({ fiveHour: { remainingPercent: 12 } })[0].level, 'low');
  assert.equal(presentation.hasSubscription({ fiveHour: { reset: true }, sevenDay: null }), false);
  assert.equal(presentation.hasSubscription({ ...quota, available: false }), false);
});

test('Claude can show one known subscription window and leaves the unknown one out', () => {
  const quota = { provider: 'Claude', fiveHour: { remainingPercent: 76.5, resetsAt: '2026-09-29T06:00:00Z' }, sevenDay: null };
  assert.equal(presentation.hasSubscription(quota), true);
  assert.deepEqual([...presentation.quotaStats(quota)].map(stat => stat.name + stat.value), ['5小时剩余77%']);
  assert.equal(presentation.quotaResets(quota).length, 1);
});

test('display snapshots keep loading, pending and unknown amounts distinct from zero', () => {
  const money = value => '$' + value.toFixed(2);
  assert.equal(presentation.balanceBubble({ status: 'loading', balance: null }, { formatMoney: money }).amount, '…');
  assert.equal(presentation.balanceBubble({ status: 'loading', balance: null }, { formatMoney: money }).hint, '加载中…');
  assert.equal(presentation.balanceBubble({ status: 'error', message: 'Offline', balance: null }, { formatMoney: money }).hint, 'Offline');
  assert.equal(presentation.balanceBubble({ status: 'ok', balance: 0, todayUsage: 0 }, { formatMoney: money }).amount, '$0.00');
  assert.equal(presentation.balanceBubble({ status: 'ok', balance: 12.3456, todayUsage: null }, { formatMoney: money }).hint, '今日 --');
  assert.equal(presentation.taskBubble({ amount: null, costState: 'pending', tokens: 120 }, money).amount, '待记账');
  assert.equal(presentation.taskBubble({ amount: null, costState: 'unknown', tokens: 120 }, money).hint, '120 tokens · 以服务商账单为准');
  const estimated = presentation.taskBubble({ amount: 0, costState: 'estimated', tokens: 120 }, money);
  assert.equal(estimated.amount, '$0.00');
  assert.equal(estimated.hint, '120 tokens · 配置价格估算');
});

test('a Codex turn on the subscription names how it ended above the quota', () => {
  const subscriptionRateLimits = { fiveHour: { remainingPercent: 75 }, sevenDay: { remainingPercent: 40 } };
  assert.deepEqual({ ...presentation.taskBubble({ completionKind: 'success', subscriptionRateLimits }) }, { kind: 'subscription', heading: 'Codex 任务完成' });
  assert.equal(presentation.taskBubble({ completionKind: 'failed', subscriptionRateLimits }).heading, 'Codex 任务未成功');
  assert.equal(presentation.taskBubble({ completionKind: 'cancelled', subscriptionRateLimits }).heading, 'Codex 任务已暂停');
});
