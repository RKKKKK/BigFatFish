import { createChatClient } from './chat-client.js';
import { createCompanionDisplay } from './companion-display.js';
import { createChatBilling } from './chat-billing.js';

const client = createChatClient(), $ = id => document.getElementById(id);
const composer = $('chat-composer'), input = $('chat-input'), reply = $('chat-reply'), output = $('chat-output');
const settingsDialog = $('chat-settings'), form = $('chat-settings-form'), status = $('chat-status');
const display = createCompanionDisplay({ pet: document.querySelector('.dshwv-img'), composer, reply, content: output, timer: $('chat-timer') });
const billing = createChatBilling({ client, root: $('chat-billing') });
let turns = [], active = null, loaded = false, loadJob = null, settings = null, busySettings = false, recoveryTimer = null;
let conversations = [], conversationId = null, busyConversations = false, deletingId = null;
let currentNotice = null, pomodoro = { phase: 'idle' }, pomodoroAt = 0, activityPolling = false, advancing = false;
const drafts = new Map();
const errorText = error => error?.message || '会话操作失败';
const field = name => form.elements.namedItem(name);
function setStatus(text) { status.textContent = text; }
function controls() {
  $('chat-send').hidden = !!active; $('chat-stop').hidden = !active;
  $('chat-new').disabled = !!active || !loaded || busyConversations;
  $('chat-send').disabled = !!active || !loaded || busyConversations || !input.value.trim();
  input.disabled = busyConversations;
  $('chat-stop').disabled = active?.stopping || false;
  for (const button of $('chat-conversations').querySelectorAll('button')) button.disabled = !!active || !loaded || busyConversations;
}
function renderConversations() {
  const list = $('chat-conversations'); list.replaceChildren();
  for (const item of [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const row = document.createElement('div'), open = document.createElement('button');
    row.className = 'chat-conversation'; row.dataset.conversationId = item.id;
    open.type = 'button'; open.className = 'chat-conversation-open'; open.title = item.title;
    open.setAttribute('aria-current', String(item.id === conversationId));
    const title = document.createElement('strong'), details = document.createElement('small');
    title.textContent = item.title;
    details.textContent = new Date(item.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · ' + item.messages + ' 轮';
    open.append(title, details); open.addEventListener('click', () => switchConversation(item.id)); row.append(open);
    const action = (label, className, callback) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.className = className; button.addEventListener('click', callback); row.append(button); return button;
    };
    if (deletingId === item.id) {
      action('确认删除', 'chat-conversation-confirm', () => deleteConversation(item.id));
      action('取消', 'chat-conversation-cancel', () => { deletingId = null; renderConversations(); });
    } else {
      const button = action('删除', 'chat-conversation-delete', () => { deletingId = item.id; renderConversations(); display.layout(); });
      button.title = '删除会话，保留消费记录'; button.setAttribute('aria-label', '删除会话：' + item.title);
    }
    list.append(row);
  }
  controls(); display.layout();
}
function applyHistory(history) {
  conversationId = history.conversationId; conversations = history.conversations; turns = history.turns;
  renderHistory(); renderConversations();
}
function resizeInput() {
  input.style.height = 'auto'; input.style.height = Math.min(120, Math.max(48, input.scrollHeight)) + 'px';
  controls(); display.layout();
}
// The history as bubbles: mine on the right, the pet's beside its picture.
function renderHistory() {
  const history = $('chat-history'), pet = document.querySelector('.dshwv-img'); history.replaceChildren();
  for (const turn of turns) {
    const pomodoro = turn.source === 'pomodoro';
    for (const [label, text, mine] of [...(turn.user ? [['我', turn.user, true]] : []), [pomodoro ? '番茄钟' : '角色', turn.text || turn.error || '', false]]) {
      const row = document.createElement('div'), heading = document.createElement('strong'), body = document.createElement('div');
      row.className = 'chat-message ' + (mine ? 'chat-message-me' : 'chat-message-pet' + (pomodoro ? ' chat-message-notice' : ''));
      heading.className = 'chat-message-who'; heading.textContent = label;
      body.className = 'chat-message-text'; body.textContent = text;
      row.append(heading);
      if (!mine) {
        const avatar = document.createElement('span'), face = document.createElement('img');
        avatar.className = 'chat-avatar'; face.alt = ''; face.src = pet?.currentSrc || pet?.src || '';
        avatar.append(face); row.append(avatar);
      }
      row.append(body); history.append(row);
    }
  }
  history.scrollTop = history.scrollHeight;
}
async function load() {
  if (loadJob) return loadJob;
  loaded = false; controls();
  loadJob = (async () => {
    const [config, history] = await Promise.all([client.settings(), client.history()]);
    settings = config.settings; loaded = true; applyHistory(history);
    clearTimeout(recoveryTimer);
    if (history.activeId) {
      active = { id: history.activeId, recovering: true, stopping: !!active?.stopping };
      recoveryTimer = setTimeout(() => load().catch(error => { setStatus(errorText(error)); loaded = false; }), 500);
    } else if (active?.recovering) { active = null; void billing.refresh({ force: true }); }
    controls();
    const last = turns.at(-1);
    display.update(last?.text || '');
    output.setAttribute('aria-busy', String(!!history.activeId));
    if (history.activeId) setStatus('正在回复');
    else if (!settings.hasKey) setStatus('尚未配置会话 API');
    else setStatus(last?.error || (last?.finishReason === 'length' ? '已达到回复长度上限' : ''));
  })().finally(() => { loadJob = null; });
  return loadJob;
}
async function open() {
  const notice = currentNotice;
  display.open();
  requestAnimationFrame(() => { window.whaleDesktop.keyboardFocus(true); input.focus({ preventScroll: true }); });
  if (!active || active.recovering) { setStatus('正在读取会话'); try { await load(); } catch (error) { loaded = false; controls(); setStatus(errorText(error)); } }
  if (notice && currentNotice === notice && !active) display.showNotice(notice.text);
  void billing.refresh();
}
async function openSettings() {
  if (busySettings) return;
  busySettings = true;
  try {
    const [result, activity] = await Promise.all([client.settings(), client.activitySettings()]); settings = result.settings;
    showAccounts();
    for (const name of ['model', 'persona', 'maxTokens', 'backgroundMaxTokens']) field(name).value = settings[name];
    field('proactiveEnabled').checked = activity.settings.enabled;
    for (const [name, value] of [['proactiveStart', activity.settings.start], ['proactiveEnd', activity.settings.end],
      ['proactiveMin', activity.settings.minMinutes], ['proactiveMax', activity.settings.maxMinutes], ['proactiveLimit', activity.settings.dailyLimit]]) field(name).value = value;
    $('chat-settings-error').hidden = true;
    if (!settingsDialog.open) settingsDialog.showModal();
    field(settings.accountId ? 'persona' : 'accountId').focus();
  } catch (error) { window.whaleToast(errorText(error)); }
  finally { busySettings = false; }
}
// The accounts the pet can talk through; keys are kept in 额度管理.
function showAccounts() {
  const picker = field('accountId');
  picker.replaceChildren(...settings.accounts.map(account => Object.assign(document.createElement('option'),
    { value: account.id, textContent: account.name + ' · ' + account.host + (account.ready ? '' : '（缺少密钥）'), selected: account.id === settings.accountId })));
  if (!settings.accounts.length) picker.append(Object.assign(document.createElement('option'), { value: '', textContent: '还没有账户，请先在额度管理里添加', disabled: true, selected: true }));
  showKeyState();
}
function showKeyState() {
  const account = settings?.accounts.find(item => item.id === field('accountId').value);
  $('chat-key-state').textContent = !account ? '请选择大肥鱼说话用的账户' : !account.ready ? '这个账户还没有可用的密钥，请在额度管理里填写' :
    account.id === settings.accountId && settings.keyStorage === 'session' ? '密钥只保留到挂件退出' : '密钥保存在额度管理里，存于本机钥匙串';
}
async function send() {
  if (active || !loaded || busyConversations || !input.value.trim()) return;
  if (!settings?.hasKey || !settings.baseUrl) { await openSettings(); return; }
  const text = input.value.trim(), id = crypto.randomUUID();
  currentNotice = null; reply.title = '';
  const turn = { id, user: text, text: '', status: 'streaming' };
  active = { id, stopping: false }; turns.push(turn); input.value = ''; resizeInput();
  display.show(''); setStatus('正在回复'); output.setAttribute('aria-busy', 'true'); renderHistory();
  try {
    await client.send(id, text, event => {
      if (event.type === 'start') void billing.refresh();
      else if (event.type === 'delta') { turn.text += event.text; display.append(event.text); }
      else if (event.type === 'done') {
        Object.assign(turn, event.turn);
        const item = conversations.find(item => item.id === conversationId);
        if (item) { if (item.kind !== 'spontaneous') item.title = [...String(turns[0].user || '').replace(/\s+/g, ' ')].slice(0, 48).join(''); item.messages = turns.length; item.updatedAt = new Date().toISOString(); }
        renderConversations();
        setStatus(turn.error || (turn.finishReason === 'length' ? '已达到回复长度上限' : ''));
      }
    }, conversationId);
  } catch (error) {
    await client.stop(id).catch(() => {});
    loaded = false;
    turn.status = 'failed'; turn.error = errorText(error); setStatus(turn.error);
    if (!turn.text && !input.value) input.value = text;
  } finally {
    active = null; output.setAttribute('aria-busy', 'false'); controls(); resizeInput(); renderHistory();
    if (!composer.hidden && !settingsDialog.open) input.focus({ preventScroll: true });
    void billing.refresh({ force: true });
  }
}
async function stop() {
  if (!active || active.stopping) return;
  active.stopping = true; controls();
  try { await client.stop(active.id); }
  catch (error) { if (active) active.stopping = false; setStatus(errorText(error)); controls(); }
}
async function changeConversation(operation) {
  if (active || !loaded || busyConversations) return;
  busyConversations = true; controls();
  const previousId = conversationId; drafts.set(previousId, input.value);
  try {
    const history = await operation(); deletingId = null; applyHistory(history);
    input.value = drafts.get(conversationId) || '';
    currentNotice = null; reply.title = '';
    display.show(turns.at(-1)?.text || '');
    $('chat-history').hidden = false; $('chat-show-history').setAttribute('aria-expanded', 'true');
    setStatus(turns.at(-1)?.error || ''); resizeInput();
  } catch (error) { setStatus(errorText(error)); }
  finally {
    busyConversations = false; controls(); display.layout();
    if (!composer.hidden && !settingsDialog.open) input.focus({ preventScroll: true });
  }
}
async function newConversation() { return changeConversation(() => client.createConversation()); }
async function switchConversation(id) { if (id !== conversationId) return changeConversation(() => client.selectConversation(id)); }
async function deleteConversation(id) {
  await changeConversation(() => client.deleteConversation(id));
  if (!conversations.some(item => item.id === id)) drafts.delete(id);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busySettings) return;
  busySettings = true; $('chat-settings-save').disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const activity = { enabled: field('proactiveEnabled').checked, start: values.proactiveStart, end: values.proactiveEnd,
      minMinutes: Number(values.proactiveMin), maxMinutes: Number(values.proactiveMax), dailyLimit: Number(values.proactiveLimit) };
    const result = await client.save(values);
    await client.saveActivitySettings(activity);
    settings = result.settings; settingsDialog.close();
    billing.reset(); void billing.refresh({ force: true });
    setStatus(''); window.whaleToast('会话设置已保存');
  } catch (error) { $('chat-settings-error').textContent = errorText(error); $('chat-settings-error').hidden = false; }
  finally { busySettings = false; $('chat-settings-save').disabled = false; }
});
settingsDialog.addEventListener('close', () => { if (!composer.hidden) input.focus(); });
field('accountId').addEventListener('change', showKeyState);
$('chat-manage-accounts').addEventListener('click', () => { settingsDialog.close(); window.dispatchEvent(new Event('whale-open-settings')); });
$('chat-settings-close').addEventListener('click', () => settingsDialog.close());
$('chat-settings-cancel').addEventListener('click', () => settingsDialog.close());
$('chat-open-settings').addEventListener('click', openSettings);
$('chat-close').addEventListener('click', () => { currentNotice = null; reply.title = ''; display.close(); });
$('chat-send').addEventListener('click', send);
$('chat-stop').addEventListener('click', stop);
$('chat-new').addEventListener('click', newConversation);
$('chat-show-conversations').addEventListener('click', () => {
  const list = $('chat-conversations'); list.hidden = !list.hidden;
  deletingId = null; renderConversations();
  $('chat-show-conversations').setAttribute('aria-expanded', String(!list.hidden)); display.layout();
});
$('chat-show-history').addEventListener('click', () => {
  const history = $('chat-history'); history.hidden = !history.hidden;
  $('chat-show-history').setAttribute('aria-expanded', String(!history.hidden)); display.layout();
  if (!history.hidden) {
    const text = turns.findLast(turn => turn.text)?.text;
    if (text) { currentNotice = null; reply.title = ''; display.show(text); }
  }
});
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  if (event.key === 'Escape') { event.preventDefault(); display.close(); }
});
// The runtime reports the remaining time; this clock only measures time since that report.
function showPomodoro(state) { pomodoro = state; pomodoroAt = Date.now(); renderPomodoro(); }
function renderPomodoro() {
  const badge = $('chat-timer'), state = pomodoro;
  const labels = { focus: '专注', break: '休息', await_break: '待休息', await_focus: '待专注', paused: '已暂停' };
  if (!labels[state.phase]) { badge.hidden = true; return; }
  const elapsed = ['focus', 'break'].includes(state.phase) ? Math.floor((Date.now() - pomodoroAt) / 1000) : 0;
  const seconds = Number.isFinite(state.remainingSeconds) ? Math.max(0, state.remainingSeconds - elapsed) : undefined;
  const clock = Number.isFinite(seconds) ? ' ' + String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : '';
  badge.textContent = labels[state.phase] + ' ' + state.cycle + '/' + state.cycles + clock;
  badge.hidden = false; display.layout();
}
async function pollActivity() {
  if (activityPolling) return;
  activityPolling = true;
  try {
    await client.presence(!composer.hidden || !!document.querySelector('.dshwv-pop-open'));
    const result = await client.activity(); showPomodoro(result.pomodoro);
    if (document.hidden || active || advancing || !result.notices.length) return;
    const notice = result.notices.find(item => item.kind === 'pomodoro') || result.notices[0];
    if (currentNotice?.seq === notice.seq) return;
    if (currentNotice && notice.kind !== 'pomodoro') return;
    currentNotice = notice;
    reply.title = notice.advance ? notice.advance.phase === 'await_break' ? '开始休息' : '开始下一轮专注' : '';
    display.showNotice(notice.text);
    if (notice.kind === 'pomodoro') window.dispatchEvent(new Event('whale-pomodoro-reminder'));
    await client.ackActivity(notice.seq);
    if (loaded) applyHistory(await client.history());
  } catch {} finally { activityPolling = false; }
}
reply.addEventListener('click', async () => {
  if (advancing) return;
  if (!currentNotice) { display.hideReply(); return; }
  const notice = currentNotice;
  if (notice.kind === 'pomodoro') {
    advancing = true;
    try {
      if (notice.advance) {
        const result = await client.advancePomodoro(notice.advance);
        showPomodoro(result.pomodoro);
      }
      if (currentNotice === notice) { currentNotice = null; reply.title = ''; display.hideReply(); }
    } catch (error) { window.whaleToast(errorText(error)); }
    finally { advancing = false; }
    return;
  }
  currentNotice = null; reply.title = ''; display.hideReply();
  await open();
  if (notice.conversationId && notice.conversationId !== conversationId) await switchConversation(notice.conversationId);
  if (!turns.at(-1)?.text) display.show(notice.text);
});
$('chat-reply-close').addEventListener('click', event => { event.stopPropagation(); currentNotice = null; reply.title = ''; display.hideReply(); });
window.addEventListener('whale-chat-open', open);
window.addEventListener('whale-open-chat-settings', openSettings);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollActivity(); });
setInterval(renderPomodoro, 1000);
setInterval(() => { void pollActivity(); }, 3000);
void pollActivity();
controls();
