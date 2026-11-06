import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore } from '../runtime/config.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { saveClaudeTurn, saveClaudeUsage } from '../runtime/claude-usage.mjs';
import { bridgeRequest } from '../runtime/bridge.mjs';
import { writeJson } from '../runtime/paths.mjs';
import { claudeFiles, recordClaudeHook } from '../runtime/agents/claude-hooks.mjs';

let clockOffset = 0;
// Sessions the task window was asked to go to; no terminal is touched.
const agentJumps = [];

export async function makeFixture(dataDir, { secretVault = null } = {}) {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome && process.env.WHALE_HOME === dataDir, 'isolated directories are required');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://fixture.example.test/v1"\nenv_key = "FIXTURE_KEY"\n');
  const config = new ConfigStore({ dataDir, codexHome, env: { FIXTURE_KEY: 'synthetic-test-key' }, secretVault });
  config.save({ provider: 'custom-json', balancePath: '/balance', balanceField: 'balance', monitorSessions: false });
  let completedChatCalls = 0;
  // Balances, the pet's included, are read through the quota book's service.
  const service = new WhaleService({ config, fetchImpl: async url => url === 'https://api.deepseek.com/user/balance' ?
    Response.json({ is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: (110 - completedChatCalls * 0.5).toFixed(2), granted_balance: '10', topped_up_balance: '100' }
    ] }) : Response.json({ balance: 12.3456 }) });
  const chatFetchImpl = async (url, { body, signal }) => {
    const input = JSON.parse(body), last = input.messages.at(-1).content.replace(/^\[[^\]]+\] /, '');
    if (last === '启动番茄钟') return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'timer_call', type: 'function', function: { name: 'pomodoro_set', arguments: '{"focusMinutes":30,"breakMinutes":5,"cycles":2}' } }
    ] } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: {
      prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100
    } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (input.messages.at(-1).role === 'tool') {
      assert.equal(JSON.parse(last).ok, true);
      completedChatCalls++;
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '好，专注三十分钟，休息五分钟，循环两轮。' } }] }) + '\n\ndata: ' +
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
          prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100
        } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    const text = last.includes('long') ? '这是逐步输出的长回复。'.repeat(90) : '第一行回复\n第二行回复';
    let timer;
    const stream = new ReadableStream({ start(controller) {
      let cursor = 0;
      const abort = () => { clearTimeout(timer); controller.error(new Error('aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      const tick = () => {
        if (signal.aborted) return;
        const delta = text.slice(cursor, cursor + 30); cursor += delta.length;
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] }) + '\n\n'));
        if (cursor < text.length) timer = setTimeout(tick, 40);
        else {
          completedChatCalls++;
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
            prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100
          } }) + '\n\ndata: [DONE]\n\n'));
          signal.removeEventListener('abort', abort); controller.close();
        }
      };
      timer = setTimeout(tick, 100);
    }, cancel() { clearTimeout(timer); } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  // Two Claude Code sessions for the task window: one asking a question, one
  // finished. The finished one is written directly, as a Stop hook would also
  // announce a finished reply.
  const now = Date.now(), ask = { session_id: 'fixture-ask', cwd: '/fixture/whale-widget' };
  recordClaudeHook(dataDir, { ...ask, hook_event_name: 'UserPromptSubmit' }, now - 120000);
  recordClaudeHook(dataDir, { ...ask, hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }, now - 60000);
  writeJson(claudeFiles(dataDir, 'fixture-done').state, { tool: 'claude', sessionId: 'fixture-done', cwd: '/fixture/paper-notes', state: 'done', since: now - 300000, startedAt: now - 600000 });
  return { service, claudeHome: path.join(dataDir, 'claude-home'), monitor: false, autoRefresh: false, chatFetchImpl,
    agentJump: async row => { agentJumps.push(row.id); return { ok: true, target: 'tab' }; }, chatActivityOptions: { now: () => Date.now() + clockOffset }, fxFetchImpl: async () => Response.json({ amount: 1, base: 'USD', date: new Date().toISOString().slice(0, 10), rates: { CNY: 7 } }) };
}

function wav() {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
  return 'data:audio/wav;base64,' + bytes.toString('base64');
}

export async function verifyDesktop({ app, window, dispatcher, dataDir, errors, setTestCursor, setTestViewport, activateChatShortcut, chatShortcutAvailable, renderInfo }) {
  const phase = process.env.WHALE_TEST_PHASE, output = process.env.WHALE_TEST_OUTPUT, passed = [], layouts = [];
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(error.message + ' Source: ' + source, { cause: error }); }
  };
  async function until(source, message) {
    for (let i = 0; i < 100; i++) {
      if (await js(`Boolean(${source})`)) return;
      await delay(100);
    }
    const state = await js("({ focused: document.activeElement?.id, chatHidden: document.getElementById('chat-composer')?.hidden, chatStatus: document.getElementById('chat-status')?.textContent, viewport: [innerWidth, innerHeight], bounds: ['.dshwv-img', '#chat-composer', '#chat-reply'].map(selector => document.querySelector(selector)?.getBoundingClientRect().toJSON()) })");
    await capture('failure');
    throw new Error(message + ': ' + JSON.stringify({ state, errors }));
  }
  const status = () => js('window.__whaleRenderTest.status()');
  // A CNY amount as the page shows it: in the display currency once a rate is known, else as yuan.
  const shown = amount => `WhaleMoney.formatMoney(${amount}, 'CNY')`;
  // Chooses how amounts show from 额度管理's title bar, as a person does.
  async function showIn(currency) {
    await js(`(() => { const select = document.querySelector('[data-quota-currency]'); select.value = ${JSON.stringify(currency)}; select.dispatchEvent(new Event('change')); })()`);
    await until(`(WhaleMoney.state().displayCurrency || '') === ${JSON.stringify(currency)} && !document.querySelector('[data-quota-currency]').disabled`, 'the display currency did not change to ' + (currency || '原币种'));
  }
  const saved = () => dispatcher.whale.readUsageSettings().approvalSound;
  const row = "[...document.querySelectorAll('.dshwv-menu-row')].find(el => el.textContent.includes('审批提醒'))";
  const timerRow = "[...document.querySelectorAll('.dshwv-menu-row')].find(el => el.textContent.includes('番茄钟'))";
  // Bubble text without its line breaks: a subscription's windows sit side by side.
  const flat = source => `(${source}).replace(/\\s+/g, '')`;
  async function approval() {
    await delay(800);
    const result = await bridgeRequest('/internal/approval-request', { method: 'POST', body: { event: 'PermissionRequest' }, dataDir });
    assert.equal(result.ok, true);
    await until("window.__whaleRenderTest.status().scene === 'approval' && document.querySelector('.dshwv-pop-open')", 'approval was not rendered');
  }
  async function click(selector, button = 'left') {
    await delay(350);
    const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    setTestCursor(point);
    await delay(200);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, ...point });
    await delay(300);
  }
  async function capture(name) {
    await delay(200);
    const frame = await window.webContents.capturePage();
    assert.ok(!frame.isEmpty());
    const pixels = frame.toBitmap();
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0), 'transparent/blank frame');
    fs.writeFileSync(path.join(output, name + '.png'), frame.toPNG());
  }
  async function measureLayout(name) {
    const layout = await js(`(() => {
      const state = window.__whaleRenderTest.status();
      const frame = document.querySelector('.dshwv-frame[data-buffer="' + state.front + '"]');
      const box = frame.closest('.dshwv-text').getBoundingClientRect();
      const bounds = rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      const rows = [...frame.querySelectorAll('.dshwv-trow, .dshwv-label, .dshwv-amount, .dshwv-hint, .dshwv-quota-head, .dshwv-quota-stat, .dshwv-quota-hint')]
        .filter(el => el.checkVisibility({ visibilityProperty: true }))
        .map(el => ({ text: el.innerText, bounds: bounds(el.getBoundingClientRect()) }));
      return { scene: state.scene, text: frame.innerText, bounds: bounds(box), rows,
        fits: rows.every(row => row.bounds.left >= box.left - 1 && row.bounds.top >= box.top - 1 && row.bounds.right <= box.right + 1 && row.bounds.bottom <= box.bottom + 1) };
    })()`);
    layouts.push({ name, ...layout });
    await capture(name);
    return layout;
  }

  await until('!!window.__whaleRenderTest && document.querySelector(".dshwv-img").naturalWidth > 0', 'renderer/assets did not load');
  await until('window.__whaleRenderTest.status().balance === 12.3456', 'balance did not load');
  for (let i = 0; !window.isVisible() && i < 150; i++) await delay(100);
  assert.ok(window.isVisible(), 'free desktop should be visible without a Codex window');
  if (phase === 'restart') {
    // The first run ends with the pet dragged to the top of the screen.
    await until("Math.abs(document.querySelector('.dshwv-img').getBoundingClientRect().top) < 1 && document.querySelector('.dshwv-root').classList.contains('dshwv-beside')", 'the pet left at the top did not come back there');
    passed.push('a pet left at the top of the screen comes back there after a restart');
    assert.equal(await js('document.documentElement.dataset.theme'), 'lace', 'the first run ends on 女仆墨蓝, which a restart keeps');
    passed.push('the chosen theme survives a full process restart');
  }
  await js('window.__whaleRenderTest.place(300, 300, false)');
  // Each bar as label:fill:value — a subscription shows the share left, an API account the money left.
  const meterRows = "[...document.querySelectorAll('.dshwv-meter:not([hidden]) .dshwv-meter-row')].map(row => row.querySelector('span').textContent + ':' + row.querySelector('.dshwv-meter-fill').style.width + ':' + (row.querySelector('.dshwv-meter-value')?.textContent || ''))";
  await until(`JSON.stringify(${meterRows}) === '["余额:100%:$12.35"]'`, 'the API balance meter is not full at the first balance seen, with the balance left');
  assert.ok(await js("document.querySelector('.dshwv-meter').getBoundingClientRect().top >= document.querySelector('.dshwv-img').getBoundingClientRect().bottom - 1"), 'the meter must sit under the pet');
  // The default role's visible bottom edge runs from 17% of its image box to the right edge.
  await until("(() => { const m = document.querySelector('.dshwv-meter').getBoundingClientRect(), i = document.querySelector('.dshwv-img').getBoundingClientRect(); return Math.abs(m.right - i.right) <= 1.5 && Math.abs(m.left - (i.left + 0.17 * i.width)) <= 2; })()", 'the meter must span the pet\'s bottom edge');
  passed.push('a usage meter under the pet shows the API balance against the full balance');
  // Observe browser audio requests without playing sounds on the developer desktop.
  await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
  passed.push('free desktop loads visible assets and balance without Codex');

  if (process.platform === 'darwin') {
    assert.equal(typeof chatShortcutAvailable, 'boolean');
    activateChatShortcut();
    await until("!document.getElementById('chat-composer').hidden && document.activeElement === document.getElementById('chat-input')", 'Ctrl+0 did not open a focused chat composer');
    assert.equal(app.isActive(), true, 'chat has DOM focus but the macOS application is inactive, so native IME has no active client');
    for (let i = 0; !window.isFocused() && i < 30; i++) await delay(100);
    assert.equal(window.isFocused(), true, 'chat must acquire native window focus before testing a later loss of focus');
    window.blur();
    for (let i = 0; window.isFocused() && i < 30; i++) await delay(100);
    assert.equal(window.isFocused(), false, 'native blur must finish before reopening chat');
    activateChatShortcut();
    for (let i = 0; !window.isFocused() && i < 30; i++) await delay(100);
    assert.equal(window.isFocused(), true, 'Ctrl+0 must restore native focus even when the composer is already open');
    await js("document.getElementById('chat-show-history').focus()");
    activateChatShortcut();
    await until("document.activeElement === document.getElementById('chat-input')", 'Ctrl+0 did not refocus an open composer');
    await js("document.getElementById('chat-close').click()");
    passed.push(chatShortcutAvailable ? 'Ctrl+0 registers globally and opens or refocuses chat input' :
      'Ctrl+0 is occupied by another instance; the same shortcut handler opens and refocuses chat input');
  }

  if (phase === 'input') {
    assert.equal(process.platform, 'darwin', 'native input focus check requires macOS');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify({ phase, passed, rendererErrors: errors }, null, 2));
    await dispatcher.close();
    app.quit();
    return;
  }

  if (phase !== 'restart') {
    // The task window: on by default in the top right corner, the session
    // waiting for the user first, then the running one, then the finished one.
    const at = Date.now();
    dispatcher.agents.codexSession({ sessionId: 'fixture-codex', cwd: '/fixture/api-server', app: false, isSubagent: false, parentThreadId: null,
      state: 'running', since: at - 360000, startedAt: at - 360000, tokens: 64500, contextWindow: 258400, eventAt: at, activeAt: at });
    const agentRows = "JSON.stringify([...document.querySelectorAll('.agents-row')].map(row => row.dataset.id))";
    await until(`${agentRows} === '["claude:fixture-ask","codex:fixture-codex","claude:fixture-done"]'`, 'the task window did not list the sessions by urgency');
    assert.equal(await js("(() => { const r = document.querySelector('.agents-mini').getBoundingClientRect(); return Math.round(innerWidth - r.right) === 16 && Math.round(r.top) === 44; })()"), true, 'the task window sits in the top right corner');
    assert.deepEqual(await js("[...document.querySelectorAll('.agents-row')].map(row => row.querySelector('.agents-state').textContent + ' ' + row.querySelector('.agents-tok').textContent)"), ['提问 ', '处理中 6m 64.5k', '完成 ']);
    await capture('agents-panel');
    await click('.agents-row[data-id="claude:fixture-done"]');
    for (let i = 0; !agentJumps.length && i < 50; i++) await delay(100);
    assert.deepEqual(agentJumps, ['claude:fixture-done']);
    await delay(2500);
    assert.ok((await js(agentRows)).includes('fixture-done'), 'going to a finished row does not remove it');
    // Swiping removes a row: a drag with the mouse, or two fingers on a trackpad.
    // A short drag springs back and is not a click.
    const swipe = (id, distance) => js(`(() => { const row = document.querySelector('.agents-row[data-id="${id}"]'), r = row.getBoundingClientRect(), y = r.y + r.height / 2;
      const at = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y });
      const x = r.x + r.width / 2;
      row.dispatchEvent(at('pointerdown', x));
      for (const step of [10, 20, 40, 70, ${distance}]) if (Math.abs(step) <= Math.abs(${distance})) row.dispatchEvent(at('pointermove', x + Math.sign(${distance}) * Math.abs(step)));
      row.dispatchEvent(at('pointerup', x + ${distance})); })()`);
    await swipe('codex:fixture-codex', -40);
    await delay(400);
    assert.ok((await js(agentRows)).includes('fixture-codex'), 'a short drag springs back');
    assert.equal(await js("document.querySelector('.agents-row[data-id=\"codex:fixture-codex\"]').style.transform"), 'translateX(0px)');
    assert.deepEqual(agentJumps, ['claude:fixture-done'], 'a drag is not a click');
    await swipe('claude:fixture-done', 160);
    await until(`!${agentRows}.includes('fixture-done')`, 'a row dragged sideways did not go');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/agents')).body).rows.some(row => row.id === 'claude:fixture-done'), false, 'a swiped row stays away');
    dispatcher.agents.codexSession({ sessionId: 'fixture-swipe', cwd: '/fixture/notes', app: true, isSubagent: false, parentThreadId: null,
      state: 'done', since: at - 60000, startedAt: at - 120000, tokens: 1200, contextWindow: 258400, eventAt: at, activeAt: at });
    await until(`${agentRows}.includes('fixture-swipe')`, 'a new row did not appear');
    await js(`(() => { const row = document.querySelector('.agents-row[data-id="codex:fixture-swipe"]');
      for (let i = 0; i < 6; i++) row.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 30, deltaY: 2 })); })()`);
    await until(`!${agentRows}.includes('fixture-swipe')`, 'a two-finger swipe did not remove the row');
    const point = await js("(() => { const r = document.querySelector('.agents-row').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    setTestCursor(point);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await until("!document.querySelector('.agents-detail').hidden && document.querySelector('.agents-detail h4').textContent === 'whale-widget'", 'resting on a row did not show its card');
    assert.equal(await js("document.querySelectorAll('.agents-detail button').length"), 1, 'the card only goes to the session; removing is a swipe');
    assert.equal(await js("(() => { const card = document.querySelector('.agents-detail').getBoundingClientRect(), box = document.querySelector('.agents-mini').getBoundingClientRect(); return card.right <= box.left && card.left >= 0; })()"), true, 'the card sits beside the panel, on the screen');
    await capture('agents-card');
    await click('.agents-head .agents-btn[aria-label="收起"]');
    await until("document.querySelector('.agents-mini').classList.contains('agents-folded')", 'the task window did not fold');
    assert.equal(await js("Math.round(innerWidth - document.querySelector('.agents-mini').getBoundingClientRect().right)"), 16, 'the folded strip stays against the right edge');
    await click('.agents-pill');
    await until("!document.querySelector('.agents-mini').classList.contains('agents-folded')", 'the folded task window did not open again');
    await js('window.__whaleRenderTest.close(); window.__whaleRenderTest.place(600, 300, false)');
    await click('.dshwv-menu-btn');
    await until("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')", 'the menu did not open for the task window');
    const agentsSwitch = "[...document.querySelectorAll('.dshwv-menu-row')].find(el => el.textContent.includes('任务小窗')).querySelector('input')";
    await js(`${agentsSwitch}.click()`);
    await until("!document.querySelector('.agents-mini') && JSON.parse(localStorage.getItem('dshw-agents')).on === false", 'turning the task window off did not remove it');
    await js(`${agentsSwitch}.click()`);
    await until("!!document.querySelector('.agents-row')", 'turning the task window on did not bring it back');
    await js("document.querySelector('.dshwv-menu-btn').click()");
    passed.push('the task window lists sessions by urgency in the top right, goes to one on a click, removes one on a swipe, shows its card, folds to the right and switches from the menu');
  }

  if (phase === 'restart') {
    const config = await dispatcher.dispatch('/api/chat/settings');
    assert.equal(JSON.parse(config.body).settings.hasKey, true, 'chat key did not survive restart');
    await click('.dshwv-img', 'right');
    await until("document.activeElement === document.getElementById('chat-input') && !document.getElementById('chat-composer').hidden", 'chat did not focus after restart');
    await until("document.getElementById('chat-output').textContent.includes('专注三十分钟')", 'chat history did not survive restart');
    await until("document.querySelector('[data-chat-spent]').textContent.includes('约') && document.querySelector('[data-chat-balance]').textContent.endsWith(" + shown('110') + ")", 'chat billing did not survive restart');
    assert.ok(JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing.recorded > 0);
    assert.equal(await js("document.querySelector('[data-chat-spent]').textContent.match(/[¥$]\\d+\\.\\d{2}$/) !== null"), true, 'chat cost shows two decimals in the display currency');
    await until("!document.getElementById('chat-timer').hidden && document.getElementById('chat-timer').textContent.includes('专注 1/2')", 'Pomodoro did not resume after restart');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/activity/settings')).body).settings.enabled, true);
    await js("document.getElementById('chat-close').click()");
    passed.push('chat, proactive settings and active Pomodoro survive a full process restart');
    const pref = saved();
    assert.ok(pref.on && pref.sel.startsWith('frag:'));
    await until(`(${row}).querySelector('select').value === ${JSON.stringify(pref.sel)}`, 'custom sound selection did not survive restart');
    await approval();
    assert.ok((await js('window.__playedAudio')).some(url => url.includes(pref.sel.slice(5))));
    passed.push('custom approval sound survives a full Electron process restart');
    const timerPref = dispatcher.whale.readUsageSettings().pomodoroSound;
    assert.deepEqual(timerPref, pref);
    await until(`(${timerRow}).querySelector('select').value === ${JSON.stringify(timerPref.sel)}`, 'custom Pomodoro sound did not survive restart');
    await js("window.__playedAudio = []; window.dispatchEvent(new Event('whale-pomodoro-reminder'))");
    assert.ok((await js('window.__playedAudio')).some(url => url.includes(timerPref.sel.slice(5))));
    passed.push('custom Pomodoro reminder sound survives a full Electron process restart');
    await capture('restart-approval');
  } else {
    await click('.dshwv-img', 'right');
    await until("document.activeElement === document.getElementById('chat-input') && !document.getElementById('chat-composer').hidden", 'right click did not open and focus composer');
    assert.equal(await js("document.getElementById('chat-composer').getBoundingClientRect().top >= document.querySelector('.dshwv-meter').getBoundingClientRect().bottom"), true, 'composer should clear the usage meter');
    assert.equal(await js("document.getElementById('chat-composer').getBoundingClientRect().top >= document.querySelector('.dshwv-img').getBoundingClientRect().bottom"), true, 'composer should be below pet');
    await js("document.getElementById('chat-open-settings').click()");
    await until("document.getElementById('chat-settings').open", 'chat settings did not open');
    assert.equal(await js("document.getElementById('chat-settings-form').elements.namedItem('backgroundMaxTokens').value"), '1024', 'proactive reply length should show its default');
    // Keys live in 额度管理: add the pet's DeepSeek account there, then choose it for chat.
    await js("document.getElementById('chat-manage-accounts').click()");
    await until("document.getElementById('quota-manager').open && !document.getElementById('chat-settings').open && !!document.querySelector('.quota-add-button')", 'chat settings did not open the quota manager');
    await js("document.querySelector('.quota-add-button').click()");
    await until("!!document.querySelector('.quota-add')", 'the add-account form did not open');
    await js(`(() => { const form = document.querySelector('.quota-add'); const values = { name: 'DeepSeek', endpoint: 'https://api.deepseek.com', key: 'synthetic-chat-key' };
      for (const [name, value] of Object.entries(values)) form.querySelector('[name=' + name + ']').value = value;
      [...form.querySelectorAll('button')].find(button => button.textContent === '保存并查询').click(); })()`);
    await until("[...document.querySelectorAll('.quota-card')].some(card => card.textContent.includes('DeepSeek') && card.textContent.includes('密钥已存入钥匙串') && card.textContent.includes('余额'))", 'the added account did not show its balance');
    assert.ok(!(await js("document.getElementById('quota-manager').innerHTML")).includes('synthetic-chat-key'), 'the manager never shows a key');
    await js(`(() => { const card = [...document.querySelectorAll('.quota-card')].find(card => card.querySelector('strong')?.textContent === 'DeepSeek');
      [...card.querySelectorAll('button')].find(button => button.textContent === '编辑').click(); })()`);
    await until("!!document.querySelector('.quota-edit [name=safeAmount]')", 'the account editor did not open');
    await js(`(() => { const form = document.querySelector('.quota-edit'); form.querySelector('[name=safeAmount]').value = '220';
      [...form.querySelectorAll('button')].find(button => button.textContent === '保存').click(); })()`);
    await until("!document.querySelector('.quota-edit') && [...document.querySelectorAll('.quota-card')].some(card => card.textContent.includes('安全额度'))", 'the safe amount did not show on the account');
    const safe = dispatcher.book.snapshot().accounts.find(account => account.name === 'DeepSeek');
    assert.deepEqual([safe.balance.full, safe.balance.safe], [220, 220], 'the balance counts against the safe amount');
    passed.push('an API account\'s safe amount is set in its editor and counts as its full bar');
    // A new currency or rate rewrites the amounts where they stand; a form being filled in keeps what was typed.
    await js(`(() => { const card = [...document.querySelectorAll('.quota-card')].find(card => card.querySelector('strong')?.textContent === 'DeepSeek');
      [...card.querySelectorAll('button')].find(button => button.textContent === '编辑').click(); })()`);
    await until("!!document.querySelector('.quota-edit [name=name]')", 'the account editor did not reopen');
    await js("document.querySelector('.quota-edit [name=name]').value = 'DeepSeek 未保存'");
    await showIn('USD');
    await until(`[...document.querySelectorAll('.quota-card')].some(card => card.querySelector('strong')?.textContent === 'DeepSeek' && card.textContent.includes('$${(110 / 7).toFixed(2)}'))`,
      'the amounts did not follow the display currency');
    await js("WhaleMoney.refreshQuote({ reason: 'timer' })");
    assert.equal(await js("document.querySelector('.quota-edit [name=name]')?.value"), 'DeepSeek 未保存', 'a new currency or rate kept what was typed');
    await js("[...document.querySelectorAll('.quota-edit button')].find(button => button.textContent === '取消').click()");
    await showIn('');
    passed.push('额度管理 rewrites its amounts for a new currency or rate in place, and a form being filled in keeps what was typed');
    await js("[...document.querySelectorAll('.quota-card[data-account-id=claude] button')].find(button => button.textContent === '接入 Claude Code').click()");
    await until("document.querySelector('.quota-card[data-account-id=claude]').textContent.includes('已接入 Claude Code')", 'connecting Claude Code did not show as connected');
    assert.match(fs.readFileSync(path.join(dataDir, 'claude-home', 'settings.json'), 'utf8'), /claude-statusline\.mjs/, 'Claude Code was connected in the test folder');
    await capture('quota-manager');
    passed.push('额度管理 adds an account with its key kept in the keychain, shows its balance, and connects Claude Code');
    await js("document.querySelector('[data-quota-close]').click()");
    await js("document.getElementById('chat-open-settings').click()");
    await until("document.getElementById('chat-settings').open && [...document.querySelector('[name=accountId]').options].some(option => option.textContent.startsWith('DeepSeek'))", 'the new account is not offered for chat');
    await js(`(() => { const form = document.getElementById('chat-settings-form'), picker = form.elements.namedItem('accountId');
      picker.value = [...picker.options].find(option => option.textContent.startsWith('DeepSeek')).value;
      for (const [key, value] of Object.entries({ model: 'deepseek-flash', persona: 'You are a whale.', maxTokens: 1024 })) form.elements.namedItem(key).value = value;
      form.requestSubmit(); })()`);
    await until("!document.getElementById('chat-settings').open", 'chat settings did not save');
    await click('#chat-input');
    await until("document.activeElement === document.getElementById('chat-input')", 'chat input did not regain focus after settings');
    await window.webContents.insertText('first');
    await until("document.getElementById('chat-input').value === 'first'", 'first line was not committed to chat input');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
    await until("document.getElementById('chat-input').value === 'first\\n'", 'Shift+Enter did not add a new line');
    await window.webContents.insertText('second');
    await until("document.getElementById('chat-input').value === 'first\\nsecond'", 'second line was not committed to chat input');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until("document.getElementById('chat-output').textContent.includes('第二行回复') && document.getElementById('chat-stop').hidden", 'Enter did not stream reply');
    await until("document.querySelector('[data-chat-spent]').textContent.includes('约') && document.querySelector('[data-chat-balance]').textContent.endsWith(" + shown('109.5') + ")", 'chat cost and balance did not refresh after reply');
    // Writing to the pet makes DeepSeek, a CNY account, the one in use; the USD account keeps its dollars.
    const accountIds = Object.fromEntries(dispatcher.book.snapshot().accounts.map(account => [account.name, account.id]));
    await js('window.__whaleRenderTest.refresh(false)');
    await until(`window.__whaleRenderTest.status().account === ${JSON.stringify(accountIds.DeepSeek)}`, 'writing to the pet did not make its account current');
    await js('window.__whaleQuotaTest.open()');
    await until(`(document.querySelector('.quota-account[data-account-id=${accountIds.fixture}]')?.textContent || '').includes('$12.35')`, 'another account in use changed this account\'s currency');
    await js('window.__whaleQuotaTest.close()');
    passed.push('making a CNY account current leaves a USD account in dollars');
    const billed = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing;
    assert.equal(billed.recorded, 1); assert.ok(billed.min > 0); assert.equal(billed.unknown, 0);
    await capture('chat-short-reply');
    const shortHeight = await js("document.getElementById('chat-reply').offsetHeight");
    await js("document.getElementById('chat-input').value = 'long'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-output').textContent.length > 60 && !document.getElementById('chat-stop').hidden", 'reply was not visible during streaming');
    await until(`document.getElementById('chat-reply').offsetHeight > ${shortHeight}`, 'reply bubble did not grow with content');
    await capture('chat-streaming-reply');
    const hiddenAt = await js("document.getElementById('chat-output').textContent.length");
    await js("document.getElementById('chat-output').click()");
    await until(`document.getElementById('chat-reply').hidden && document.getElementById('chat-output').textContent.length > ${hiddenAt + 30}`, 'stream output reopened a manually hidden reply');
    activateChatShortcut();
    await until("document.activeElement === document.getElementById('chat-input')", 'shortcut did not refocus during streaming');
    assert.equal(await js("document.getElementById('chat-reply').hidden"), true, 'shortcut reopened a dismissed reply');
    await js("document.getElementById('chat-show-history').click()");
    await until("!document.getElementById('chat-reply').hidden && document.getElementById('chat-history').hidden === false", 'opening history did not restore the dismissed reply');
    await js("document.getElementById('chat-output').click()");
    await until("document.getElementById('chat-reply').hidden", 'reply did not dismiss after being restored');
    await js("document.getElementById('chat-stop').click()");
    await until("document.getElementById('chat-stop').hidden && document.getElementById('chat-status').textContent.includes('已停止')", 'stop did not finish generation');
    await js("document.getElementById('chat-input').value = 'next'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-output').textContent.includes('第二行回复') && document.getElementById('chat-stop').hidden", 'could not chat after cancellation');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    const injection = await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__chatStreamCutTest = true;
      const original = window.fetch.bind(window); let cut = false;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (args[0] !== '/api/chat/message' || cut) return response;
        cut = true; const reader = response.body.getReader();
        return new Response(new ReadableStream({ async start(controller) {
          for (let i = 0; i < 2; i++) { const chunk = await reader.read(); if (chunk.done) break; controller.enqueue(chunk.value); }
          controller.close(); await reader.cancel();
        } }), { headers: response.headers, status: response.status });
      };
    })();` });
    window.webContents.reload();
    await until("window.__chatStreamCutTest && !!window.__whaleRenderTest && !!document.getElementById('chat-input')", 'chat reload failed');
    await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
    await click('.dshwv-img', 'right');
    await until("document.activeElement === document.getElementById('chat-input') && !document.getElementById('chat-new').disabled", 'chat did not load after renderer restart');
    await js("document.getElementById('chat-input').value = 'long interrupted'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-status').textContent.includes('重新打开') && document.getElementById('chat-stop').hidden", 'stream interruption was not reported');
    await js("document.getElementById('chat-close').click()");
    await click('.dshwv-img', 'right');
    await until("!document.getElementById('chat-new').disabled && document.getElementById('chat-status').textContent.includes('已停止')", 'reopening did not synchronize interrupted history');
    const recovered = JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).turns.at(-1);
    assert.ok(recovered.text.length > 0, 'interrupted stream lost all partial text');
    assert.equal(await js("document.getElementById('chat-output').textContent"), recovered.text);
    await js("document.getElementById('chat-input').value = 'next'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-output').textContent.includes('第二行回复') && document.getElementById('chat-stop').hidden", 'could not send after recovering history');
    await window.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
    window.webContents.debugger.detach();
    passed.push('reopening after an interrupted stream synchronizes persisted partial text and permits a later reply');
    const firstConversation = JSON.parse((await dispatcher.dispatch('/api/chat/history')).body);
    await js("document.getElementById('chat-input').value = 'unsent draft'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-new').click();");
    await until("!document.getElementById('chat-new').disabled && document.getElementById('chat-input').value === '' && document.activeElement === document.getElementById('chat-input')", 'new conversation did not reset and focus input');
    const secondConversation = JSON.parse((await dispatcher.dispatch('/api/chat/history')).body);
    assert.notEqual(secondConversation.conversationId, firstConversation.conversationId);
    assert.equal(secondConversation.turns.length, 0); assert.equal(secondConversation.conversations.length, 2);
    await js("document.getElementById('chat-input').value = 'second topic'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-stop').hidden && !document.getElementById('chat-new').disabled", 'second conversation did not finish');
    await js("document.getElementById('chat-show-conversations').click()");
    const firstRow = `.chat-conversation[data-conversation-id="${firstConversation.conversationId}"]`;
    const secondRow = `.chat-conversation[data-conversation-id="${secondConversation.conversationId}"]`;
    await js(`document.querySelector(${JSON.stringify(firstRow + ' .chat-conversation-open')}).click()`);
    await until("!document.getElementById('chat-new').disabled && document.getElementById('chat-input').value === 'unsent draft' && document.activeElement === document.getElementById('chat-input')", 'switching conversation lost its draft or input focus');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).turns.length, firstConversation.turns.length);
    await js("document.getElementById('chat-input').value = 'continue original topic'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-stop').hidden && !document.getElementById('chat-new').disabled", 'resumed conversation did not finish');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).turns.length, firstConversation.turns.length + 1);
    assert.equal(await js("document.querySelector('[data-chat-spent]').textContent.match(/[¥$]\\d+\\.\\d{2}$/) !== null"), true, 'chat cost shows two decimals in the display currency');
    await capture('chat-conversation-list');
    const originalBounds = window.getBounds();
    for (const [width, height] of [[1024, 768], [390, 844]]) {
      setTestViewport({ ...originalBounds, width, height });
      await until(`window.innerWidth === ${width} && window.innerHeight === ${height}`, 'native viewport resize failed');
      await delay(350);
      for (const edge of ['bottom', 'top']) {
        await js(`window.__whaleRenderTest.place(${width - 240}, ${edge === 'bottom' ? height - 240 : 0}, false)`);
        for (const history of [false, true]) {
          await js(`if (document.getElementById('chat-history').hidden !== ${!history}) document.getElementById('chat-show-history').click()`);
          await delay(500);
          await until(`(() => { const pet = document.querySelector('.dshwv-img').getBoundingClientRect(); const box = document.getElementById('chat-composer').getBoundingClientRect(); const reply = document.getElementById('chat-reply').getBoundingClientRect(); const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; return box.top >= pet.bottom && !overlap(reply, box) && !overlap(reply, pet) && [box, reply].every(r => r.left >= 0 && r.top >= 0 && r.right <= ${width} && r.bottom <= ${height}); })()`, 'chat surfaces did not fit viewport ' + width + ', edge ' + edge + ', history ' + history);
          await capture('chat-viewport-' + width + '-' + edge + (history ? '-history' : ''));
        }
      }
    }
    setTestViewport(null);
    const beforeDelete = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing;
    await js(`document.querySelector(${JSON.stringify(secondRow + ' .chat-conversation-delete')}).click()`);
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).conversations.length, 2, 'delete should await explicit confirmation');
    await capture('chat-conversation-delete-confirmation');
    await js(`document.querySelector(${JSON.stringify(secondRow + ' .chat-conversation-confirm')}).click()`);
    await until("document.querySelectorAll('.chat-conversation').length === 1 && !document.getElementById('chat-new').disabled", 'confirmed conversation deletion failed');
    const afterDelete = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing;
    assert.equal(afterDelete.recorded, beforeDelete.recorded); assert.equal(afterDelete.min, beforeDelete.min);
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).conversationId, firstConversation.conversationId);
    await js("document.getElementById('chat-show-conversations').click()");
    passed.push('conversation list creates independent sessions, restores drafts, resumes old history and deletes only the chosen session while preserving billing');
    await js("document.getElementById('chat-input').value = '启动番茄钟'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-output').textContent.includes('专注三十分钟') && document.getElementById('chat-stop').hidden", 'model tool call did not complete in chat');
    await until("!document.getElementById('chat-timer').hidden && document.getElementById('chat-timer').textContent.includes('专注 1/2')", 'active Pomodoro badge did not appear');
    await until("(() => { const badge = document.getElementById('chat-timer').getBoundingClientRect(); const composer = document.getElementById('chat-composer').getBoundingClientRect(); const reply = document.getElementById('chat-reply').getBoundingClientRect(); const overlaps = box => badge.left < box.right && badge.right > box.left && badge.top < box.bottom && badge.bottom > box.top; return badge.top >= 0 && badge.bottom <= innerHeight && !overlaps(composer) && !overlaps(reply); })()", 'Pomodoro badge was covered by chat surfaces');
    const timerState = JSON.parse((await dispatcher.dispatch('/api/chat/activity')).body).pomodoro;
    assert.equal(timerState.focusMinutes, 30); assert.equal(timerState.breakMinutes, 5); assert.equal(timerState.cycles, 2);
    await capture('chat-pomodoro-active');
    const timerViewport = window.getBounds();
    setTestViewport({ ...timerViewport, width: 390, height: 844 });
    await until('innerWidth === 390 && innerHeight === 844', 'timer viewport resize failed');
    for (const edge of ['top', 'bottom']) {
      await js(`window.__whaleRenderTest.place(150, ${edge === 'top' ? 0 : 600}, false)`);
      await until("(() => { const badge = document.getElementById('chat-timer').getBoundingClientRect(); const composer = document.getElementById('chat-composer').getBoundingClientRect(); const reply = document.getElementById('chat-reply').getBoundingClientRect(); const overlaps = box => badge.left < box.right && badge.right > box.left && badge.top < box.bottom && badge.bottom > box.top; return badge.left >= 0 && badge.right <= innerWidth && badge.top >= 0 && badge.bottom <= innerHeight && !overlaps(composer) && !overlaps(reply); })()", 'timer badge overlapped chat at ' + edge + ' edge');
      await capture('chat-pomodoro-390-' + edge);
    }
    setTestViewport(null);
    await js('window.__whaleRenderTest.place(300, 300, false)');
    await js("document.getElementById('chat-close').click(); window.__playedAudio = []");
    clockOffset += 31 * 60000;
    await until("!document.getElementById('chat-reply').hidden && document.getElementById('chat-reply').title === '开始休息'", 'focus end did not show an actionable reminder');
    const beforeClick = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing.recorded;
    await delay(3300);
    assert.equal((await js('window.__playedAudio')).filter(url => url.includes('release') && url.includes('fx1')).length, 1, 'reminder sound must play once per notice');
    await capture('chat-pomodoro-break-reminder');
    await click('#chat-output');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/activity')).body).pomodoro.phase, 'break');
    await until("/休息 1\\/2 0[45]:\\d\\d/.test(document.getElementById('chat-timer').textContent)", 'break countdown must follow the runtime clock');
    assert.equal(await js("document.getElementById('chat-composer').hidden && document.getElementById('chat-reply').hidden"), true, 'click should advance without opening chat');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing.recorded, beforeClick, 'phase click must not make a model request');
    clockOffset += 6 * 60000;
    await until("!document.getElementById('chat-reply').hidden && document.getElementById('chat-reply').title === '开始下一轮专注'", 'break end did not show an actionable reminder');
    await click('#chat-output');
    const nextFocus = JSON.parse((await dispatcher.dispatch('/api/chat/activity')).body).pomodoro;
    assert.equal(nextFocus.phase, 'focus'); assert.equal(nextFocus.cycle, 2);
    assert.equal(await js("document.getElementById('chat-composer').hidden"), true);
    passed.push('clicking a reminder starts break or next focus without a chat message; sound plays once and clicks do not incur API charges');
    clockOffset = 0;
    activateChatShortcut();
    await until("!document.getElementById('chat-composer').hidden && !document.getElementById('chat-new').disabled", 'chat did not reopen after timer clicks');
    await js("document.getElementById('chat-input').value = '启动番茄钟'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click()");
    await until("document.getElementById('chat-output').textContent.includes('专注三十分钟') && document.getElementById('chat-stop').hidden", 'timer reset for restart did not finish');
    await js("document.getElementById('chat-open-settings').click()");
    await until("document.getElementById('chat-settings').open && document.querySelector('[name=proactiveStart]').value === '09:00'", 'proactive settings did not load');
    await js("document.querySelector('[name=proactiveEnabled]').checked = true; document.getElementById('chat-settings-form').requestSubmit()");
    await until("!document.getElementById('chat-settings').open", 'proactive settings did not save');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/activity/settings')).body).settings.enabled, true);
    passed.push('model tool call sets Pomodoro without a permission prompt; timer badge and proactive settings persist');
    await js("document.getElementById('chat-history').hidden = true");
    await js('window.__whaleRenderTest.place(300, 300, false)');
    await js("document.getElementById('chat-close').click()");
    passed.push('native right click focuses a below-pet composer; Enter sends, Shift+Enter adds a line, streamed reply grows and stop permits a later reply');

    const now = Date.now();
    const rateLimits = { observedAt: now, planType: 'plus',
      fiveHour: { usedPercent: 25, windowMinutes: 300, resetsAt: now + 3600000 },
      sevenDay: { usedPercent: 60, windowMinutes: 10080, resetsAt: now + 86400000 } };
    dispatcher.whale.updateSubscriptionRateLimits(rateLimits);
    dispatcher.whale.updateSubscriptionRateLimitContext({ observedAt: now, usesSubscription: true });
    // A Codex turn on the subscription makes it the account in use.
    dispatcher.book.codexTurn({ ts: now, subscription: true });
    await js('window.__whaleRenderTest.refresh(true)');
    await until("document.querySelector('.dshwv-root').title.includes('Codex 订阅') && window.__whaleRenderTest.status().account === 'codex'", 'subscription did not replace API display');
    await until(`JSON.stringify(${meterRows}) === '["5h:75%:75%","7d:40%:40%"]'`, 'the meter did not switch to the 5h and 7d quota, with the share left');
    assert.equal(await js("document.querySelector('.dshwv-meter-name').textContent"), 'Codex', 'the meter names the account in use');
    passed.push('the usage meter shows remaining 5h and 7d quota for a subscription and names it');
    saveClaudeUsage(dataDir, { rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor(now / 1000) + 3600 },
      seven_day: { used_percentage: 65, resets_at: Math.floor(now / 1000) + 86400 } } }, now);
    window.webContents.reload();
    await until("!!window.__whaleRenderTest && window.__whaleRenderTest.status().account === 'codex'", 'a reload lost the account in use');
    await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
    saveClaudeTurn(dataDir, { hook_event_name: 'Stop', session_id: 'fixture' }, now + 1000);
    await js('window.__whaleRenderTest.poll()');
    await until("document.querySelector('.dshwv-root').title.includes('Claude 订阅') && window.__whaleRenderTest.status().account === 'claude'", 'a Claude reply did not make Claude the account in use');
    await until("window.__whaleRenderTest.status().scene === 'cost' && !window.__whaleRenderTest.status().switching && Number(getComputedStyle(document.querySelector('.dshwv-pop-open .dshwv-bshape')).opacity) > 0.99 && Number(getComputedStyle(document.querySelector('.dshwv-pop-open .dshwv-text')).opacity) > 0.99 && [...document.querySelectorAll('.dshwv-pop-open .dshwv-frame')].some(el => " + flat('el.innerText') + ".includes('Claude回复完成5小时剩余80%') && Number(getComputedStyle(el).opacity) > 0.99)", 'Claude reply did not open a visible completion bubble');
    assert.equal((await measureLayout('claude-completion')).fits, true, 'Claude completion must fit the visible bubble');
    assert.equal(await js("window.__whaleRenderTest.status().scene === 'cost' && document.querySelector('.dshwv-pop').classList.contains('dshwv-pop-open')"), true,
      'Claude completion closed before its screenshot finished');
    await js('window.__whaleRenderTest.close()');
    await click('.dshwv-img');
    await until("[...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => " + flat('el.innerText') + ".includes('Claude订阅额度5小时剩余80%7天剩余35%'))", 'click after Claude reply did not show Claude quota side by side');
    assert.equal((await measureLayout('claude-quota')).fits, true, 'Claude quota rows must fit the visible bubble');
    await js('window.__whaleRenderTest.close()');
    fs.rmSync(path.join(dataDir, 'claude-subscription.json'));
    await js('window.__whaleRenderTest.refresh(false)');
    await until("document.querySelector('.dshwv-root').title.includes('Claude 订阅 · 等 Claude 下次回复后更新')", 'missing Claude quota should be unknown');
    await click('.dshwv-meter-head');
    await until("!document.querySelector('.quota-overview').hidden && !!document.querySelector('.quota-account[data-account-id=codex] .quota-select')", 'the meter did not open the quota overview');
    assert.deepEqual(await js("[...document.querySelectorAll('.quota-account')].map(card => card.dataset.accountId).slice(0, 2)"), ['codex', 'claude']);
    await capture('quota-overview');
    await click('.quota-account[data-account-id=codex] .quota-select');
    await until("window.__whaleRenderTest.status().account === 'codex' && document.querySelector('.dshwv-root').title.includes('Codex 订阅')", 'choosing Codex in the overview did not switch the pet');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await until("document.querySelector('.quota-overview').hidden", 'Escape did not close the overview');
    passed.push('a Claude reply makes Claude the account in use, opens a completion bubble, and click shows the latest Claude usage');
    passed.push('missing Claude quota reads as waiting, and the overview behind the meter lists every account and switches to the one chosen');
    await js("window.dispatchEvent(new CustomEvent('whale-open-settings', { detail: { tab: 'records' } }))");
    await until("document.getElementById('quota-manager').open && document.querySelector('[data-tab=records]').getAttribute('aria-selected') === 'true' && !!document.querySelector('.quota-chart')", 'the records page did not open');
    assert.ok(await js("[...document.querySelectorAll('.quota-card')].some(card => card.textContent.includes('近 7 天') && card.textContent.includes('近 30 天'))"), 'records show the spend totals');
    await capture('quota-records');
    await js("document.querySelector('[data-tab=alerts]').click()");
    await until("!!document.querySelector('.quota-alerts')", 'the reminders page did not open');
    await js("(() => { const form = document.querySelector('.quota-alerts'); form.elements.namedItem('windowPercent').value = '50'; form.elements.namedItem('turnCostSeconds').value = '7'; })()");
    // Switching the display currency while reminders are being filled in keeps what was typed.
    await showIn('CNY');
    await js("[...document.querySelectorAll('.quota-alerts button')].find(button => button.textContent === '保存').click()");
    await until("document.getElementById('toast').textContent === '提醒设置已保存'", 'reminder settings were not saved');
    assert.equal(dispatcher.whale.readUsageSettings().quotaAlerts.windowPercent, 50);
    assert.equal(await js("(() => { let state; addEventListener('whale-notice-settings-state', event => { state = event.detail; }, { once: true }); dispatchEvent(new Event('whale-notice-settings-request')); return state.turnCostCloseMs; })()"), 7000,
      'the completion bubble time moved from the menu to the reminders page');
    await showIn('');
    await capture('quota-alerts');
    await js("document.querySelector('[data-quota-close]').click()");
    await js('window.__whaleRenderTest.refresh(false)');
    await until("window.__whaleRenderTest.status().scene === 'alert' && [...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => el.innerText.includes('Codex 7d 额度不足'))", 'the quota reminder did not show');
    await js('window.__whaleRenderTest.close()');
    dispatcher.whale.writeUsageSettings({ quotaAlerts: { windowPercent: 20 } });
    passed.push('额度管理 shows records with a seven-day chart and saves reminders, and the pet shows a quota reminder once');
    await click('.dshwv-img');
    await until("[...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => " + flat('el.innerText') + ".includes('Codex订阅额度5小时剩余75%7天剩余40%') && Number(getComputedStyle(el).opacity) > 0.99)", 'native subscription click did not become visible');
    const clickLayout = await measureLayout('subscription-native-click');
    assert.ok(clickLayout.fits, 'the subscription click text overflowed its content area');
    assert.equal(await js("document.querySelectorAll('.dshwv-pop-open .dshwv-frame[aria-hidden=false] .dshwv-quota-stat').length"), 2, 'the two windows sit side by side');
    await click('.dshwv-pop-open .dshwv-bshape');
    await until('!window.__whaleRenderTest.status().shown', 'a click on the bubble did not close it');
    passed.push('a click on the pet shows the quota in use, the windows side by side, and a click on the bubble closes it');
    const quotaTurn = { id: 'fixture:subscription', sessionId: 'fixture', turnId: 'subscription', ts: Date.now(),
      subscriptionRateLimits: rateLimits,
      byModel: { 'test-model': { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } };
    dispatcher.whale.beginTurn(quotaTurn);
    await dispatcher.whale.finishTurn(quotaTurn);
    await js('window.__whaleRenderTest.poll()');
    await until("window.__whaleRenderTest.status().scene === 'cost' && !window.__whaleRenderTest.status().switching && " + flat('window.__whaleRenderTest.status().text') + ".includes('Codex任务完成5小时剩余75%') && [...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => Number(getComputedStyle(el).opacity) > 0.99)", 'subscription completion did not become visible');
    const completionLayout = await measureLayout('subscription-completion');
    assert.deepEqual(completionLayout.rows.map(row => row.text.replace(/\s+/g, '')).slice(0, 3), ['Codex任务完成', '5小时剩余75%', '7天剩余40%']);
    assert.ok(!completionLayout.text.includes('待记账'));
    assert.ok(completionLayout.fits, 'subscription completion text overflowed its content area');
    passed.push('the subscription click and completion fit their content area');
    await js('window.__whaleRenderTest.close()');
    const completed = { id: 'fixture:completed', sessionId: 'fixture', turnId: 'completed', ts: Date.now(),
      byModel: { 'test-model': { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } };
    dispatcher.whale.beginTurn(completed);
    await dispatcher.whale.finishTurn(completed);
    await js('window.__whaleRenderTest.poll()');
    await until("window.__whaleRenderTest.status().scene === 'cost' && window.__whaleRenderTest.status().text.includes('待记账') && window.__whaleRenderTest.status().text.includes('120 tokens')", 'task result did not become a cost bubble');
    await until("[...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => el.innerText.includes('待记账') && Number(getComputedStyle(el).opacity) > 0.99)", 'task cost text did not become visible');
    await capture('task-cost-display');
    await js('window.__whaleRenderTest.close()');
    await until("window.__whaleRenderTest.status().account !== 'codex' && document.querySelector('.dshwv-root').title.includes('Codex API')", 'a turn on the API did not make its account current');
    passed.push('a Codex turn makes the account it ran on current, and a turn on the API maps to a pending-cost bubble');

    await js(`(${timerRow}).querySelector('input').click()`);
    for (let i = 0; dispatcher.whale.readUsageSettings().pomodoroSound.on && i < 50; i++) await delay(100);
    assert.equal(dispatcher.whale.readUsageSettings().pomodoroSound.on, false);
    await js("window.__playedAudio = []; window.dispatchEvent(new Event('whale-pomodoro-reminder'))");
    assert.deepEqual(await js('window.__playedAudio'), []);
    assert.equal(dispatcher.whale.readUsageSettings().approvalSound.on, true);
    assert.equal(dispatcher.whale.readUsageSettings().taskEnd.on, false);
    passed.push('Pomodoro sound toggle persists independently from approval and task completion sounds');

    await approval();
    assert.ok((await js('window.__playedAudio')).some(url => url.includes('fx1') && url.includes('release')));
    await js('window.__whaleRenderTest.showCost(1)');
    await delay(300);
    assert.equal((await status()).scene, 'approval', 'completion displaced approval');
    await capture('persistent-approval');
    await click('.dshwv-pop-open');
    await until("window.__whaleRenderTest.status().scene === 'cost'", 'the completion queued behind approval did not show after dismissal');
    passed.push('approval queues a completion behind it and dismisses on bubble click, which then shows the completion');

    await approval();
    await click('.dshwv-img');
    assert.notEqual((await status()).scene, 'approval');
    passed.push('native pet click dismisses approval');

    await js(`(${row}).querySelector('input').click()`);
    await until(`(${row}).querySelector('input').checked === false`, 'sound switch did not toggle');
    for (let i = 0; saved().on && i < 50; i++) await delay(100);
    assert.equal(saved().on, false);
    await js('window.__playedAudio = []');
    await approval();
    assert.deepEqual(await js('window.__playedAudio'), []);
    passed.push('approval mute persists and leaves the visual reminder enabled');

    const uploaded = await dispatcher.dispatch('/dsh-whale/audio.json', { method: 'POST', body: { action: 'upload-fragment', name: 'Baseline test sound', audio: wav() } });
    assert.equal(uploaded.status, 200);
    const id = JSON.parse(uploaded.body).id;
    window.webContents.reload();
    await until(`!!window.__whaleRenderTest && !!(${row})?.querySelector('select option[value="frag:${id}"]')`, 'custom sound was not loaded');
    assert.equal(await js(`(${row}).querySelector('input').checked`), false);
    await js(`(${row}).querySelector('input').click(); const select = (${row}).querySelector('select'); select.value = ${JSON.stringify('frag:' + id)}; select.dispatchEvent(new Event('change'));`);
    for (let i = 0; saved().sel !== 'frag:' + id && i < 50; i++) await delay(100);
    assert.deepEqual(saved(), { on: true, sel: 'frag:' + id });
    assert.equal(await js(`(${timerRow}).querySelector('input').checked`), false, 'Pomodoro mute did not survive reload');
    await js(`(() => { (${timerRow}).querySelector('input').click(); const select = (${timerRow}).querySelector('select'); select.value = ${JSON.stringify('frag:' + id)}; select.dispatchEvent(new Event('change')); })()`);
    for (let i = 0; dispatcher.whale.readUsageSettings().pomodoroSound.sel !== 'frag:' + id && i < 50; i++) await delay(100);
    assert.deepEqual(dispatcher.whale.readUsageSettings().pomodoroSound, { on: true, sel: 'frag:' + id });
    assert.equal(dispatcher.whale.readUsageSettings().taskEnd.on, false);
    const media = await dispatcher.dispatch('/dsh-whale/audio-fragment.wav?id=' + id);
    assert.equal(media.status, 200);
    assert.ok(media.body.length > 44);
    await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
    await js("window.dispatchEvent(new Event('whale-pomodoro-reminder'))");
    assert.ok((await js('window.__playedAudio')).some(url => url.includes(id)));
    passed.push('Pomodoro reminder plays imported custom audio with task completion sound disabled');
    await approval();
    assert.ok((await js('window.__playedAudio')).some(url => url.includes(id)));
    passed.push('imported WAV plays with completion sound disabled and persists for next startup');
    await capture('custom-approval');
    await js('window.__whaleRenderTest.close(); window.__whaleRenderTest.place(600, 300, false)');
    await click('.dshwv-menu-btn');
    await until("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')", 'sound settings menu did not open');
    await until("(() => { const badge = document.getElementById('chat-timer').getBoundingClientRect(); const menu = document.querySelector('.dshwv-menu-open')?.getBoundingClientRect(); return menu && (badge.right <= menu.left || badge.left >= menu.right || badge.bottom <= menu.top || badge.top >= menu.bottom); })()", 'timer badge covered the sound settings menu');
    await capture('reminder-sound-settings');
    assert.equal(await js(`(() => { const row = (${timerRow}); const label = row.querySelector('span').getBoundingClientRect(); const check = row.querySelector('input').getBoundingClientRect(); return label.right <= check.left && row.scrollWidth <= row.clientWidth; })()`), true, 'Pomodoro sound row overlaps or overflows');
    assert.equal(await js("[...document.querySelectorAll('.dshwv-menu button')].some(button => button.textContent.includes('自定义泡泡'))"), false, 'the custom bubble editor is gone');
    await js("document.querySelector('.dshwv-menu-btn').click()");
    // Three themes, chosen in the menu and kept: each surface takes its colors.
    // The default theme needs no saved choice; another one is kept as dshw-theme.
    const theme = name => `document.documentElement.dataset.theme === ${JSON.stringify(name)} && (localStorage.getItem('dshw-theme') || 'soda') === ${JSON.stringify(name)}`;
    assert.equal(await js("document.documentElement.dataset.theme"), 'soda', 'the first theme is the default');
    for (const name of ['soda', 'abyss', 'lace']) {
      await js('window.__whaleRenderTest.close(); window.__whaleRenderTest.place(600, 300, false)');
      await click('.dshwv-menu-btn');
      await until("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')", 'the menu did not open for the theme ' + name);
      await click(`.dshwv-theme-pick[data-theme-id=${name}]`);
      await until(theme(name) + ` && document.querySelector('.dshwv-theme-pick[data-theme-id=${name}]').getAttribute('aria-pressed') === 'true'`, 'choosing the theme ' + name + ' did not apply it');
      assert.notEqual(await js("getComputedStyle(document.querySelector('.dshwv-menu')).backgroundColor"), 'rgba(0, 0, 0, 0)', 'the menu has a surface in ' + name);
      await capture('theme-' + name + '-menu');
      await js("document.querySelector('.dshwv-menu-btn').click()");
      await click('.dshwv-img');
      await until("!window.__whaleRenderTest.status().switching && [...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => Number(getComputedStyle(el).opacity) > 0.99)", 'the quota bubble did not show in ' + name);
      await capture('theme-' + name + '-bubble');
      await js('window.__whaleRenderTest.close(); window.__whaleQuotaTest.open()');
      await until("!document.querySelector('.quota-overview').hidden", 'the overview did not open in ' + name);
      await capture('theme-' + name + '-overview');
      await js('window.__whaleQuotaTest.close()');
      await js("window.dispatchEvent(new Event('whale-chat-open'))");
      await until("!document.getElementById('chat-composer').hidden && !document.getElementById('chat-new').disabled", 'chat did not open in ' + name);
      await js("if (document.getElementById('chat-history').hidden) document.getElementById('chat-show-history').click()");
      await until("!document.getElementById('chat-history').hidden && !!document.querySelector('.chat-message-pet .chat-avatar img')", 'chat history did not show bubbles in ' + name);
      await capture('theme-' + name + '-chat');
      await js("document.getElementById('chat-close').click()");
      await js("window.dispatchEvent(new CustomEvent('whale-open-settings', { detail: { tab: 'records' } }))");
      await until("document.getElementById('quota-manager').open && !!document.querySelector('.quota-chart')", 'the records did not open in ' + name);
      await capture('theme-' + name + '-records');
      await js("document.querySelector('[data-quota-close]').click()");
    }
    passed.push('the menu switches between the three themes and every surface takes the chosen colors');
    // Last, as the restart phase finds the pet where this leaves it: dragged past the top of the
    // screen, the pet's picture stops at the top and its bubble sits beside its head. The pet's
    // own pointer handlers drag it, as a mouse held on its picture does.
    await js(`(() => { const pet = document.querySelector('.dshwv-img'), r = pet.getBoundingClientRect(), x = r.x + r.width / 2;
      const at = (type, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y });
      pet.dispatchEvent(at('pointerdown', r.y + r.height / 2));
      for (const y of [r.y, r.y - 150, 0]) document.dispatchEvent(at('pointermove', y));
      document.dispatchEvent(at('pointerup', 0)); })()`);
    await until("Math.abs(document.querySelector('.dshwv-img').getBoundingClientRect().top) < 1 && document.querySelector('.dshwv-root').classList.contains('dshwv-beside')", 'the pet did not reach the top of the screen');
    assert.equal(JSON.parse(await js("localStorage.getItem('dshw-pos')")).vAnchor, 'top', 'the place at the top is kept');
    await click('.dshwv-img');
    await until("!!document.querySelector('.dshwv-pop-open')", 'clicking the pet at the top did not open its bubble');
    await delay(700);
    const beside = await js(`(() => { const box = selector => document.querySelector(selector).getBoundingClientRect();
      const pet = box('.dshwv-img'), cloud = box('.dshwv-pop .dshwv-bshape'), dot = box('.dshwv-pop .dshwv-b2'), mid = r => r.left + r.width / 2;
      return { cloudTop: cloud.top, overlap: cloud.left < pet.right && cloud.right > pet.left,
        between: (mid(dot) - mid(cloud)) * (mid(pet) - mid(dot)) > 0, level: dot.top + dot.height / 2 > pet.top && dot.top + dot.height / 2 < pet.bottom }; })()`);
    assert.deepEqual(beside, { cloudTop: beside.cloudTop, overlap: false, between: true, level: true }, 'the bubble sits beside the pet and its dots lead to it');
    assert.ok(beside.cloudTop >= 0, 'the bubble stays on the screen');
    await capture('pet-at-top');
    await js('window.__whaleRenderTest.close()');
    passed.push('dragged past the top, the pet stops with its picture at the top and its bubble beside its head');
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify({ version: '0.2.6', phase, passed, layouts, rendering: renderInfo(), rendererErrors: errors }, null, 2));
  await dispatcher.close();
  app.quit();
}
