import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UsageLedger } from '../runtime/ledger.mjs';
import { dayKey } from '../runtime/paths.mjs';
import { cleanAlertSettings, evaluateAlerts, legacyAlertSettings } from '../runtime/quota/alerts.mjs';
import { apiRecords, subscriptionTurns } from '../runtime/quota/records.mjs';
import { fixture, turn } from './helpers/fixture.mjs';

const DAY = 86400000;
const window = (remainingPercent, extra = {}) => ({ id: '5h', label: '5h', remainingPercent, ...extra });
const codex = (percent, available = true) => ({ id: 'codex', name: 'Codex', available, windows: [window(percent)], balance: null, spend: null });
const deepseek = (amount, today = 0) => ({ id: 'api-ds', name: 'DeepSeek', available: true, windows: [],
  balance: { amount, currency: 'CNY', full: 50 }, spend: { currency: 'CNY', today } });
const relay = today => ({ id: 'api-relay', name: 'labkey', available: true, balance: null, spend: { currency: 'USD', today },
  windows: [{ id: 'limit-1', label: '额度', remainingPercent: 41, remaining: 165, currency: 'USD' }] });

test('a low quota is told once per crossing, and again only after it recovered', () => {
  const settings = cleanAlertSettings({ windowPercent: 20 }), day = '2026-10-05';
  let state = evaluateAlerts({ accounts: [codex(50)], settings, day });
  assert.deepEqual(state.raised, []);
  state = evaluateAlerts({ accounts: [codex(15)], settings, fired: state.fired, day });
  assert.deepEqual(state.raised.map(alert => [alert.title, alert.text]), [['Codex 5h 额度不足', '剩余 15%']]);
  state = evaluateAlerts({ accounts: [codex(10)], settings, fired: state.fired, day });
  assert.deepEqual(state.raised, [], 'still low: not told again');
  state = evaluateAlerts({ accounts: [codex(10, false)], settings, fired: state.fired, day });
  state = evaluateAlerts({ accounts: [codex(10)], settings, fired: state.fired, day });
  assert.deepEqual(state.raised, [], 'an account that could not be read meanwhile is not told again');
  state = evaluateAlerts({ accounts: [codex(90)], settings, fired: state.fired, day });
  state = evaluateAlerts({ accounts: [codex(12)], settings, fired: state.fired, day });
  assert.equal(state.raised.length, 1, 'after recovering, a new crossing is told');
  assert.deepEqual(evaluateAlerts({ accounts: [codex(5)], settings: cleanAlertSettings({ on: false }), day }).raised, []);
});

test('a balance is low against its full balance or a floor in its own currency, and a day\'s budget counts per currency', () => {
  const day = '2026-10-05';
  const low = evaluateAlerts({ accounts: [deepseek(8)], settings: cleanAlertSettings({ balancePercent: 20 }), day });
  assert.deepEqual(low.raised.map(alert => alert.text), ['余额 ¥8.00，满格的 16%']);
  assert.equal(evaluateAlerts({ accounts: [deepseek(30)], settings: cleanAlertSettings({ balanceBelow: { CNY: 40 } }), day }).raised.length, 1);
  const safe = { ...deepseek(8), balance: { amount: 8, currency: 'CNY', full: 20, safe: 20 } };
  assert.deepEqual(evaluateAlerts({ accounts: [safe], settings: cleanAlertSettings({ balancePercent: 50 }), day }).raised.map(alert => alert.text), ['余额 ¥8.00，安全额度的 40%'],
    'with a safe amount the share is of the safe amount');
  const safeWindow = { ...relay(0), windows: [{ id: 'limit-1', label: '额度', remainingPercent: 30, remaining: 30, currency: 'USD', safe: 100 }] };
  assert.deepEqual(evaluateAlerts({ accounts: [safeWindow], settings: cleanAlertSettings({ windowPercent: 50 }), day }).raised.map(alert => alert.text), ['剩 $30.00，安全额度的 30%']);
  assert.equal(evaluateAlerts({ accounts: [deepseek(30)], settings: cleanAlertSettings({ balanceBelow: { USD: 40 } }), day }).raised.length, 0, 'a floor in another currency does not apply');
  const money = evaluateAlerts({ accounts: [relay(9)], settings: cleanAlertSettings({ windowPercent: 50 }), day });
  assert.deepEqual(money.raised.map(alert => alert.text), ['剩余 41%（$165.00）']);
  const budget = cleanAlertSettings({ budgetOn: true, dailyBudget: { USD: 10, CNY: 5 } });
  let state = evaluateAlerts({ accounts: [relay(9), deepseek(45, 1)], settings: budget, day });
  assert.deepEqual(state.raised, []);
  state = evaluateAlerts({ accounts: [relay(12), deepseek(45, 1)], settings: budget, fired: state.fired, day });
  assert.deepEqual(state.raised.map(alert => [alert.title, alert.text]), [['今日消费已超过 $10.00', '今天已用 $12.00']]);
  state = evaluateAlerts({ accounts: [relay(15), deepseek(45, 1)], settings: budget, fired: state.fired, day });
  assert.deepEqual(state.raised, [], 'once a day');
  assert.equal(evaluateAlerts({ accounts: [relay(15)], settings: budget, fired: state.fired, day: '2026-10-06' }).raised.length, 1, 'a new day can tell again');
});

test('reminder settings are checked, and the old warning and budget carry over in their currency', () => {
  assert.throws(() => cleanAlertSettings({ windowPercent: 120 }), /0 到 100/);
  assert.throws(() => cleanAlertSettings({ dailyBudget: { USD: -1 } }), /非负/);
  assert.deepEqual(cleanAlertSettings({ balanceBelow: { USD: '', CNY: '30' } }).balanceBelow, { CNY: 30 }, 'an empty amount means no reminder');
  assert.deepEqual(legacyAlertSettings({ alert: { on: true, below: 5 }, budget: { on: true, amount: 10 } }, 'USD'),
    { on: true, windowPercent: 20, balancePercent: 20, balanceBelow: { USD: 5 }, budgetOn: true, dailyBudget: { USD: 10 } });
});

test('usage settings keep the old reminders as quota reminders and save new ones', t => {
  const { service, createService, dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, 'usage-settings.json'), JSON.stringify({ alert: { on: true, below: 5 }, budget: { on: true, amount: 10 } }));
  assert.deepEqual(service.readUsageSettings().quotaAlerts, { on: true, windowPercent: 20, balancePercent: 20, balanceBelow: { USD: 5 }, budgetOn: true, dailyBudget: { USD: 10 } });
  service.writeUsageSettings({ quotaAlerts: { windowPercent: 30, dailyBudget: { USD: 25 } } });
  const saved = createService().readUsageSettings();
  assert.equal(saved.quotaAlerts.windowPercent, 30);
  assert.deepEqual(saved.quotaAlerts.dailyBudget, { USD: 25 });
  assert.deepEqual(saved.quotaAlerts.balanceBelow, { USD: 5 });
  assert.throws(() => service.writeUsageSettings({ quotaAlerts: { balancePercent: -5 } }), /0 到 100/);
});

test('records split a shared account between Codex and the pet, and estimate the pet\'s own days', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-records-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ledger = new UsageLedger(dataDir), now = new Date(2026, 9, 5, 12).getTime();
  ledger.append('aaaaaaaaaaaaaaaaaaaaaaaa-USD', { id: 's:t1', ts: now - DAY, outcome: 'completed', cost: 4, costState: 'observed', tokens: 1200, currency: 'USD',
    model: 'gpt-5 · 期间扣费（同密钥合计）', byModel: { 'gpt-5': {} } });
  ledger.append('aaaaaaaaaaaaaaaaaaaaaaaa-USD', { id: 's:t0', ts: now - DAY, isSubagent: true, cost: 1, tokens: 10, currency: 'USD' });
  const account = { uses: ['codex:relay', 'pet'], ledgers: ['aaaaaaaaaaaaaaaaaaaaaaaa'], context: { setting: { currency: 'USD' } } };
  const result = { currency: 'USD', todayUsage: 3, dailyUsage: [{ date: dayKey(now - DAY), cost: 10 }, { date: dayKey(now - 2 * DAY), cost: 6 }] };
  const requests = [{ at: now - DAY + 1000, model: 'deepseek-flash', tokens: 900, amount: 0.5, currency: 'USD', state: 'estimated', outcome: 'completed' },
    { at: now - 1000, model: 'deepseek-flash', tokens: null, amount: null, currency: 'USD', state: 'pending', outcome: 'streaming' }];
  const shared = apiRecords({ account, ledger, result, requests, now });
  assert.equal(shared.split, true);
  assert.deepEqual(shared.days[1], { date: dayKey(now - DAY), total: 10, estimated: false, pet: 0.5, codex: 9.5 });
  assert.deepEqual([shared.today, shared.days7, shared.days30], [3, 19, 19]);
  assert.deepEqual(shared.events.map(event => [event.kind, event.model, event.state]),
    [['pet', 'deepseek-flash', 'pending'], ['pet', 'deepseek-flash', 'estimated'], ['codex', 'gpt-5', 'observed']], 'subagent rows stay inside their turn');
  const meterKey = 'c'.repeat(64);
  ledger.observe('aaaaaaaaaaaaaaaaaaaaaaaa-USD', { totalBalance: 100, meterKey }, now - DAY - 1000);
  ledger.observe('aaaaaaaaaaaaaaaaaaaaaaaa-USD', { totalBalance: 96, meterKey }, now - DAY + 500);
  const petOnly = apiRecords({ account: { ...account, uses: ['pet'] }, ledger, result: { currency: 'USD' }, requests, now });
  assert.deepEqual(petOnly.days[1], { date: dayKey(now - DAY), total: 4, estimated: false, pet: 0.5, codex: null }, 'a day the pet observed wins over the estimate');
  assert.deepEqual([petOnly.days[2].total, petOnly.days[29].total], [null, null], 'days before the first request are unknown');
  const quiet = apiRecords({ account: { ...account, uses: ['pet'], ledgers: [] }, ledger, result: { currency: 'USD' },
    requests: [{ ...requests[0], at: now - 3 * DAY }], now });
  assert.deepEqual([quiet.days[2].total, quiet.days[2].estimated], [0, true], 'a day after the first request without any cost nothing');
  ledger.append('bbbbbbbbbbbbbbbbbbbbbbbb-USD', { id: 's:plan', ts: now - 500, outcome: 'completed', tokens: 300, model: 'gpt-5 · 仅 token 记录', byModel: { 'gpt-5': {} },
    subscriptionRateLimits: { fiveHour: { remainingPercent: 70 }, sevenDay: null } });
  assert.deepEqual(subscriptionTurns({ dataDir, ledger }), [{ at: now - 500, model: 'gpt-5', tokens: 300, outcome: 'completed', fiveHour: 70, sevenDay: null }]);
});

test('a shared-key bill says when the pet used the account during the turn', async t => {
  let used = 0;
  const { service } = fixture(t, { used: () => used });
  service.petUsedDuring = (context, from, to) => context.sourceName === 'Work' && to >= from;
  const meta = turn('shared', { provider: 'work' });
  service.beginTurn(meta);
  used = 2;
  await service.finishTurn(meta);
  assert.match(service.lastTurn().note, /期间大肥鱼也用这个账户说过话/);
  assert.equal(service.lastTurn().amount, 2);
});
