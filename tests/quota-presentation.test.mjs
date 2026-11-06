import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const presentation = browserModule('quota-presentation.js');
// The module runs in its own realm; compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));
const money = (amount, currency) => (currency === 'CNY' ? '¥' : '$') + amount.toFixed(2);
const now = new Date(2026, 9, 5, 2, 30).getTime();
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

const codex = { id: 'codex', type: 'subscription', provider: 'codex', name: 'Codex', plan: 'plus', uses: ['codex'], available: true, observedAt: at(5, 1),
  windows: [{ id: '5h', label: '5h', reset: true },
    { id: '7d', label: '7d', usedPercent: 60, remainingPercent: 40, windowMinutes: 10080, resetsAt: at(9, 10), pace: { projectedPercent: 146, exhaustAt: new Date(2026, 9, 8, 9, 21).getTime() } }] };
const claude = { id: 'claude', type: 'subscription', provider: 'claude', name: 'Claude', plan: '', uses: ['claude'], available: false, windows: [] };
const labkey = { id: 'api-labkey', type: 'api', provider: 'api', name: 'labkey', uses: ['codex:OpenAI'], available: true,
  windows: [{ id: 'limit-1', label: '额度', limit: 400, remaining: 165.16, used: 234.84, currency: 'USD', remainingPercent: 41.29, resetsAt: '2026-10-09T00:00:00+08:00' }],
  balance: null, spend: { currency: 'USD', today: 21.05, days7: 580.25, average: { amount: 86.42, days: 7, currency: 'USD' } },
  pace: { enough: false, exhaustAt: new Date(2026, 9, 7, 2, 0).getTime(), average: { amount: 86.42, days: 7, currency: 'USD' } } };
const deepseek = { id: 'api-deepseek', type: 'api', provider: 'api', name: 'DeepSeek', uses: ['pet'], available: true, windows: [],
  balance: { amount: 49.19, used: null, currency: 'CNY', full: 50 }, spend: { currency: 'CNY', today: 0, days7: 0.57, average: { amount: 0.1, days: 7, currency: 'CNY' } },
  pace: { daysLeft: 491.9, average: { amount: 0.1, days: 7, currency: 'CNY' } } };

test('accounts are named by what they are and what uses them', () => {
  assert.equal(presentation.title(codex), 'Codex 订阅 · Plus');
  assert.equal(presentation.title(claude), 'Claude 订阅');
  assert.equal(presentation.title(labkey), 'labkey · Codex API');
  assert.equal(presentation.title(deepseek), 'DeepSeek · 大肥鱼');
  assert.equal(presentation.title({ ...deepseek, uses: ['codex:deepseek', 'pet'] }), 'DeepSeek · Codex API · 大肥鱼');
  assert.deepEqual([codex, labkey, deepseek, null].map(presentation.label), ['Codex 订阅额度', 'labkey 额度', 'DeepSeek 余额', '额度']);
});

test('the bars under the pet show each valid window, an API quota, or the balance against its full value', () => {
  assert.deepEqual(plain(presentation.meters(codex)), [{ label: '7d', percent: 40, level: 'warn', value: '40%' }], 'a window that reset has no bar; a subscription shows the share left');
  assert.deepEqual(plain(presentation.meters(labkey, { formatMoney: money })), [{ label: '额度', percent: 41.29, level: 'warn', value: '$165.16' }], 'an API quota shows the money left');
  assert.deepEqual(plain(presentation.meters(deepseek, { formatMoney: money })), [{ label: '余额', percent: 98.38, level: 'ok', value: '¥49.19' }], 'a balance shows the balance');
  assert.deepEqual(plain(presentation.meters(labkey)), [{ label: '额度', percent: 41.29, level: 'warn' }]);
  assert.deepEqual(plain(presentation.meters(deepseek)), [{ label: '余额', percent: 98.38, level: 'ok' }]);
  assert.deepEqual(plain(presentation.meters({ ...deepseek, balance: { amount: 4, currency: 'CNY', full: null } })), [], 'no full balance, no bar');
  assert.deepEqual(plain(presentation.meters({ ...deepseek, balance: { unlimited: true, currency: 'CNY' } })), []);
  assert.deepEqual(plain(presentation.meters(null)), []);
});

test('moments read as a time today, tomorrow, a weekday this week, else a date', () => {
  assert.equal(presentation.moment(new Date(2026, 9, 5, 14, 20).getTime(), now), '14:20');
  assert.equal(presentation.moment(at(6, 9, 5), now), '明天 9:05');
  assert.equal(presentation.moment(at(9, 10), now), '周五 10:00');
  assert.equal(presentation.moment(at(12, 0), now), '10月12日 0:00');
  assert.equal(presentation.moment('not a time', now), '');
});

test('the overview lists what is left, when it resets and how long it lasts at this rate', () => {
  const options = { formatMoney: money, now };
  assert.deepEqual(plain(presentation.rows(codex, options)), [{ label: '5h', percent: null, level: 'ok', value: '已重置', note: '' },
    { label: '7d', percent: 40, level: 'warn', value: '40%', note: '周五 10:00 重置' }]);
  assert.equal(presentation.paceText(codex, options), '按这个速度，7d 额度约 周四 9:21 用完');
  assert.equal(presentation.paceText({ ...codex, windows: [{ ...codex.windows[1], pace: { projectedPercent: 80, exhaustAt: null } }] }, options), '按这个速度，重置前够用');
  assert.equal(presentation.paceText({ ...codex, windows: [{ ...codex.windows[1], pace: null }] }, options), '', 'too early in the window to tell');
  const [limit] = presentation.rows(labkey, options);
  assert.equal(limit.value, '剩 $165.16 / $400.00');
  assert.match(limit.note, / 0:00 重置$/);
  assert.equal(presentation.paceText(labkey, options), '今日 $21.05 · 按近 7 天日均 $86.42，约 周三 2:00 用完，早于重置');
  assert.equal(presentation.paceText({ ...labkey, pace: { enough: true, exhaustAt: null } }, options), '今日 $21.05 · 按近 7 天日均 $86.42，重置前够用');
  assert.deepEqual(plain(presentation.rows(deepseek, options)), [{ label: '余额', percent: 98.38, level: 'ok', value: '¥49.19', note: '' }]);
  assert.equal(presentation.paceText(deepseek, options), '今日 ¥0.00 · 按近 7 天日均 ¥0.10，约可用 492 天');
  assert.equal(presentation.paceText({ ...deepseek, spend: { ...deepseek.spend, average: { amount: 0, days: 3, currency: 'CNY' } } }, options), '今日 ¥0.00 · 近 3 天没有消费');
});

test('the overview keeps accounts with quota, a problem, or in use, and says why one is empty', () => {
  const broken = { id: 'source-work', type: 'api', provider: 'api', name: 'work', uses: [], available: false, windows: [], error: '缺少密钥' };
  const snapshot = { current: 'claude', accounts: [codex, claude, labkey, deepseek, broken, { ...claude, id: 'other', provider: 'codex' }] };
  assert.deepEqual(presentation.overview(snapshot).map(account => account.id), ['codex', 'claude', 'api-labkey', 'api-deepseek', 'source-work']);
  assert.equal(presentation.current(snapshot).id, 'claude');
  assert.equal(presentation.status(claude), '等 Claude 下次回复后更新');
  assert.equal(presentation.status(broken), '缺少密钥');
  assert.equal(presentation.status({ ...labkey, stale: true, error: '网络中断' }), '上次成功数据 · 网络中断');
  assert.equal(presentation.status(labkey), '');
});

test('the current account becomes the state the pet\'s bubbles read', () => {
  const subscription = plain(presentation.bubbleState(codex));
  assert.equal(subscription.subscription.provider, 'Codex');
  assert.deepEqual(subscription.subscription.fiveHour, { reset: true });
  assert.equal(subscription.subscription.sevenDay.remainingPercent, 40);
  assert.equal(subscription.balance, null);
  const waiting = plain(presentation.bubbleState(claude));
  assert.equal(waiting.subscription, null);
  assert.equal(waiting.status, 'error');
  assert.equal(waiting.message, '等 Claude 下次回复后更新');
  const quota = plain(presentation.bubbleState(labkey));
  assert.deepEqual([quota.balance, quota.currency, quota.todayUsage, quota.quota.limit], [165.16, 'USD', 21.05, 400]);
  const balance = plain(presentation.bubbleState(deepseek));
  assert.deepEqual([balance.balance, balance.currency, balance.balanceFull], [49.19, 'CNY', 50]);
  assert.equal(presentation.bubbleState({ ...deepseek, balance: { unlimited: true, currency: 'CNY' } }).balance, Infinity);
  assert.equal(presentation.bubbleState(null).status, 'loading');
});

test('a page that shows today\'s spend apart leaves it out of the pace sentence', () => {
  assert.equal(presentation.paceText(deepseek, { formatMoney: money, now, today: false }), '按近 7 天日均 ¥0.10，约可用 492 天');
});

test('an account with a safe amount says so beside its bar', () => {
  const options = { formatMoney: money, now };
  assert.equal(presentation.rows({ ...deepseek, balance: { ...deepseek.balance, full: 20, safe: 20 } }, options)[0].note, '安全额度 ¥20.00');
  assert.match(presentation.rows({ ...labkey, windows: [{ ...labkey.windows[0], remainingPercent: 100, safe: 100 }] }, options)[0].note, / 0:00 重置 · 安全额度 \$100\.00$/);
  assert.deepEqual(plain(presentation.meters({ ...deepseek, balance: { amount: 45.2, currency: 'CNY', full: 20, safe: 20 } })), [{ label: '余额', percent: 100, level: 'ok' }], 'above the safe amount the bar is full');
});
