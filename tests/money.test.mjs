import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const { createMoneyState } = browserModule('money.js');
const quote = { usdCny: 7, date: '2026-10-05', retrievedAt: new Date().toISOString() };
const offline = async () => { throw new Error('offline'); };

test('with no currency chosen each amount shows in its own, whichever account is in use', async () => {
  const money = createMoneyState({ loadQuote: async () => quote });
  await money.ready();
  assert.equal(money.state().displayCurrency, null);
  assert.equal(money.formatMoney(130.84, 'USD'), '$130.84');
  assert.equal(money.formatMoney(49.19, 'CNY'), '¥49.19', 'a CNY account does not turn a USD account into yuan, or the other way');
  assert.equal(money.formatMoney(5, undefined), '--', 'an amount without a currency is not taken for dollars');
});

test('a chosen currency converts every amount once a rate is known, and choosing none goes back', async () => {
  let saved = null;
  const money = createMoneyState({ loadQuote: async () => quote, savePreference: value => { saved = value; } });
  assert.equal(await money.setDisplayCurrency('USD'), true);
  assert.deepEqual([money.formatMoney(70, 'CNY'), money.formatMoney(130.84, 'USD'), saved], ['$10.00', '$130.84', 'USD']);
  await money.setDisplayCurrency('CNY');
  assert.equal(money.formatMoney(10, 'USD'), '¥70.00');
  await money.setDisplayCurrency(null);
  assert.deepEqual([money.formatMoney(10, 'USD'), money.state().displayCurrency, saved], ['$10.00', null, '']);
});

test('a currency no rate converts, such as HKD, keeps its own under a chosen one', async () => {
  const money = createMoneyState({ readPreference: () => 'USD', loadQuote: async () => quote });
  await money.ready();
  assert.deepEqual([money.formatMoney(12.34, 'HKD'), money.formatMoney(12.34, 'HKD', true), money.formatMoney(70, 'CNY', true)],
    ['HKD 12.34', 'HKD 12.34', '$ 10.00']);
});

test('a chosen currency without a rate shows each amount in its own currency rather than nothing', async () => {
  const money = createMoneyState({ readPreference: () => 'CNY', loadQuote: offline });
  await money.ready();
  assert.equal(money.state().displayCurrency, 'CNY');
  assert.deepEqual([money.formatMoney(12.5, 'USD'), money.formatMoney(45.2, 'CNY')], ['$12.50', '¥45.20']);
});

test('choosing a currency with no rate is kept without an error, and the first rate to come converts at once', async () => {
  let online = false;
  const money = createMoneyState({ loadQuote: async () => { if (!online) throw new Error('offline'); return quote; } });
  assert.equal(await money.setDisplayCurrency('USD'), false, 'amounts are not converted yet');
  assert.deepEqual([money.state().displayCurrency, money.formatMoney(12.34, 'USD'), money.formatMoney(70, 'CNY')], ['USD', '$12.34', '¥70.00']);
  online = true;
  await money.refreshQuote({ reason: 'timer' });
  assert.equal(money.formatMoney(70, 'CNY'), '$10.00', 'a background check does not keep the first rate waiting');
});

test('a choice made while an earlier one waits for the first rate is the one that counts', async () => {
  const money = createMoneyState({ loadQuote: offline });
  const earlier = money.setDisplayCurrency('USD');
  await money.setDisplayCurrency(null);
  assert.equal(await earlier, true, 'the earlier choice no longer waits for a rate, so nothing is said about it');
  assert.equal(money.state().displayCurrency, null);
});

test('choosing each amount\'s own currency while the first rate is on its way still uses that rate', async () => {
  let arrive;
  const coming = new Promise(resolve => { arrive = resolve; });
  const money = createMoneyState({ readPreference: () => 'CNY', loadQuote: () => coming });
  const started = money.ready();
  await money.setDisplayCurrency(null);
  arrive(quote);
  assert.equal(await started, true);
  assert.deepEqual([money.state().quote?.usdCny, money.state().hasPendingQuote], [7, false]);
});

test('a new currency rewrites bound amounts where they stand', async () => {
  const money = createMoneyState({ loadQuote: async () => quote });
  await money.ready();
  const node = { textContent: '' };
  money.bind(node, () => money.formatMoney(70, 'CNY'));
  assert.equal(node.textContent, '¥70.00');
  await money.setDisplayCurrency('USD');
  assert.equal(node.textContent, '$10.00');
});
