import { createChatClient } from '/chat-client.js';

// The independent workbench window: a larger view of the Codex / DSH / Claude
// tasks the task window shows, plus the workbench settings and a second view of
// the character conversation. Everything is read through the same local
// whale:// routes as the pet; this page has no Node access.
(() => {
  'use strict';
  const POLL_MS = 2000;
  const STATE = { running: '处理中', done: '完成', question: '提问', permission: '要权限', stuck: '卡住', failed: '出错', aborted: '中断', idle: '空闲' };
  const TOOL = { codex: 'Codex', dsh: 'DSH', claude: 'Claude Code' };
  const $ = id => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  let rows = [], counts = {}, dsh = null, drafts = [], runnerInfo = null, limits = null, filter = 'all', selected = '', error = '';
  let timer = null, toastTimer = null, settings = null, settingsLoaded = false, pendingStop = '', pendingStopTimer = null;
  let memoryView = null, memoryLoaded = false, editingId = '', pendingForget = '', pendingImport = false, pendingClear = false;
  let pendingTimer = null;
  let view = 'detail';
  let timelineRange = 1;
  let paletteResults = [], paletteIndex = 0, paletteReturnFocus = null;
  const summaries = new Map();
  const outputCache = new Map();
  const outputExpanded = new Set();
  const outputScroll = new Map();
  const outputFollow = new Map();
  const chat = createChatClient();
  let chatTurns = [], chatConversationId = '', chatConversations = [], chatGenerating = false, chatActiveId = '';

  function color(row) { return row.color || 'gray'; }
  function titleOf(row) { return row.title || row.name || '未命名任务'; }
  function taskStatusLabel(value) {
    return ({ draft: '草稿', queued: '排队', starting: '启动中', running: '进行中', stopping: '停止中',
      done: '完成', failed: '失败', timeout: '超时', aborted: '中断' }[value] || value || '');
  }
  function stateText(row) {
    const label = STATE[row.state] || row.state || '';
    if ((row.state === 'running' || row.state === 'stuck') && Number.isFinite(row.since)) {
      const minutes = Math.max(0, Math.floor((Date.now() - row.since) / 60000));
      if (minutes >= 1) return label + ' ' + (minutes < 60 ? minutes + ' 分钟' : Math.floor(minutes / 60) + ' 小时');
    }
    return label;
  }
  function duration(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return '不到 1 分钟';
    if (minutes < 60) return minutes + ' 分钟';
    return Math.floor(minutes / 60) + ' 小时' + (minutes % 60 ? ' ' + minutes % 60 + ' 分钟' : '');
  }
  function tokens(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return String(Math.round(value));
    if (value < 100000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (value < 1e6) return Math.round(value / 1000) + 'k';
    return (value / 1e6).toFixed(1) + 'M';
  }
  function ago(value) {
    if (!Number.isFinite(value)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
    return Math.floor(seconds / 3600) + ' 小时前';
  }

  async function request(route, method = 'GET', body) {
    const response = await fetch(route, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({ ok: false, error: '本地服务没有返回有效数据' }));
    if (!response.ok || data.ok === false) throw new Error(data.error || '操作未完成');
    return data;
  }

  function visibleRows() {
    return filter === 'all' ? rows : rows.filter(row => row.tool === filter);
  }

  function showError(message) {
    error = message || '';
    const node = $('wb-error');
    node.textContent = error;
    node.hidden = !error;
  }

  function toast(message) {
    const node = $('wb-toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  function dotFor(row) {
    const node = el('i', 'wb-dot ' + color(row));
    if (row.state === 'running') node.classList.add('busy');
    else if (row.color === 'red' || row.color === 'yellow') node.classList.add('alert');
    return node;
  }

  function renderDrafts() {
    const target = $('wb-drafts');
    target.replaceChildren();
    if (!drafts.length) { target.hidden = true; return; }
    target.hidden = false;
    for (const draft of drafts) {
      const card = el('article', 'wb-draft');
      const main = el('div', 'wb-draft-main');
      main.append(el('b', '', (TOOL[draft.tool] || draft.tool) + ' · 待确认'), el('p', '', draft.prompt || ''), el('small', '', draft.cwd || ''));
      const actions = el('div', 'wb-draft-actions');
      const start = el('button', 'primary', '确认启动');
      start.type = 'button';
      start.addEventListener('click', () => startDraft(draft.id));
      const cancel = el('button', '', '放弃');
      cancel.type = 'button';
      cancel.addEventListener('click', () => cancelDraft(draft.id));
      actions.append(start, cancel);
      card.append(main, actions);
      target.append(card);
    }
  }

  async function startDraft(id) {
    try {
      await request('/api/workbench/tasks/start', 'POST', { draftId: id });
      toast('已开始');
      refresh();
    } catch (problem) { toast(problem.message || '没能启动'); }
  }

  async function cancelDraft(id) {
    try {
      await request('/api/workbench/tasks/cancel', 'POST', { draftId: id });
      toast('已放弃');
      refresh();
    } catch (problem) { toast(problem.message || '没能取消'); }
  }

  async function stopTask(id) {
    if (pendingStop !== id) { pendingStop = id; clearTimeout(pendingStopTimer); pendingStopTimer = setTimeout(() => { pendingStop = ''; renderDetail(); }, 4000); renderDetail(); return; }
    pendingStop = ''; clearTimeout(pendingStopTimer);
    try {
      await request('/api/workbench/tasks/stop', 'POST', { id });
      toast('已停止');
      refresh();
    } catch (problem) { toast(problem.message || '没能停止'); }
  }

  function renderSummary() {
    const target = $('wb-summary');
    const cards = [
      { label: '运行中', value: counts.running || 0, cls: 'good' },
      { label: '等你处理', value: counts.waiting || 0, cls: counts.waiting ? 'warn' : '' },
      { label: '已完成', value: counts.done || 0, cls: 'good' },
      { label: '出错 / 中断', value: counts.failed || 0, cls: counts.failed ? 'bad' : '' },
    ];
    target.replaceChildren(...cards.map(card => {
      const node = el('div', 'wb-stat ' + card.cls);
      node.append(el('b', '', String(card.value)), el('span', '', card.label));
      return node;
    }));
    const tools = counts.byTool || {};
    const run = runnerInfo ? '下发 ' + (runnerInfo.active || 0) + '/' + (runnerInfo.maxConcurrent || 2) + ((runnerInfo.queue || []).length ? ' · 排队 ' + runnerInfo.queue.length : '') : '';
    $('wb-dsh-state').textContent = [
      'Codex ' + (tools.codex || 0),
      'DSH ' + (tools.dsh || 0),
      'Claude ' + (tools.claude || 0),
    ].join(' · ') + (dsh?.error ? ' · ' + dsh.error : dsh?.enabled === false ? ' · DSH 未启用' : '');
    if ($('wb-runner-info')) $('wb-runner-info').textContent = run || '空闲';
    if ($('wb-pet-status')) $('wb-pet-status').textContent = '监控 ' + (counts.total || 0) + ' 个任务' + (run ? ' · ' + run : '');
    const pet = document.querySelector('.wb-pet-card');
    if (pet) pet.dataset.state = counts.failed ? 'failed' : counts.waiting ? 'waiting' : (counts.running || counts.stuck) ? 'running' : 'idle';
  }

  function renderRhythm() {
    const target = $('wb-rhythm');
    if (!target) return;
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const beginDay = day.getTime(), endDay = beginDay + 24 * 60 * 60 * 1000, now = Date.now();
    const buckets = Array.from({ length: 24 }, () => ({ tasks: 0, state: 'idle', row: null }));
    const rank = { idle: 0, done: 1, running: 2, waiting: 3, failed: 4 };
    for (const row of rows) {
      let begin = Number(row.startedAt ?? row.since ?? row.activeAt);
      if (!Number.isFinite(begin)) continue;
      const running = row.state === 'running' || row.state === 'stuck';
      let end = Number(row.finishedAt ?? (running ? now : row.activeAt ?? begin));
      if (!Number.isFinite(end)) end = begin;
      begin = Math.max(beginDay, Math.min(endDay, begin));
      end = Math.max(begin + 60000, Math.min(endDay, end));
      if (end <= beginDay || begin >= endDay) continue;
      const state = ['failed', 'aborted', 'timeout'].includes(row.state) ? 'failed'
        : row.state === 'question' || row.state === 'permission' ? 'waiting'
          : running ? 'running' : 'done';
      const first = Math.max(0, Math.floor((begin - beginDay) / 3600000));
      const last = Math.min(23, Math.floor((end - beginDay - 1) / 3600000));
      for (let hour = first; hour <= last; hour++) {
        buckets[hour].tasks++;
        if (!buckets[hour].row) buckets[hour].row = row;
        if (rank[state] > rank[buckets[hour].state]) buckets[hour].state = state;
      }
    }
    const currentHour = new Date(now).getHours();
    target.replaceChildren(...buckets.map((bucket, hour) => {
      const cell = el('button', 'wb-rhythm-cell ' + bucket.state + (hour === currentHour ? ' now' : ''));
      cell.type = 'button';
      cell.title = String(hour).padStart(2, '0') + ':00 · ' + bucket.tasks + ' 个任务';
      cell.addEventListener('click', () => {
        if (!bucket.row) return;
        selected = bucket.row.id;
        showView('detail');
        render();
      });
      return cell;
    }));
    const labels = el('div', 'wb-rhythm-labels');
    labels.append(el('span', '', '0'), el('span', '', '6'), el('span', '', '12'), el('span', '', '18'), el('span', '', '24'));
    target.append(labels);
  }

  function limitRow(label, entry) {
    const row = el('div', 'wb-limit-row');
    row.append(el('span', 'wb-limit-name', label));
    if (!entry || entry.available === false) {
      row.append(el('span', 'wb-limit-empty', '—'));
      return row;
    }
    for (const [key, name] of [['fiveHour', '5h'], ['sevenDay', '7d']]) {
      const window = entry[key];
      if (!window || !Number.isFinite(window.remainingPercent)) {
        row.append(el('span', 'wb-limit-window', name + ' —'));
        continue;
      }
      const cell = el('span', 'wb-limit-window');
      cell.title = name + ' · 剩余 ' + Math.round(window.remainingPercent) + '% · 重置 ' + (window.resetsAt || '未知');
      cell.append(
        el('small', '', name),
        el('span', 'wb-limit-bar', ''),
        el('b', '', Math.round(window.remainingPercent) + '%'),
      );
      const bar = cell.querySelector('.wb-limit-bar');
      bar.style.setProperty('--value', Math.max(0, Math.min(100, window.remainingPercent)) + '%');
      if (window.remainingPercent < 25) bar.classList.add('low');
      row.append(cell);
    }
    return row;
  }

  function renderLimits() {
    const target = $('wb-limits');
    if (!target) return;
    target.replaceChildren(
      limitRow('Codex', limits?.codex),
      limitRow('Claude', limits?.claude),
      limitRow('DSH', null),
    );
  }

  function renderPulse() {
    renderRhythm();
    renderLimits();
  }

  function renderRightMemory() {
    const target = $('wb-right-memory');
    if (!target) return;
    target.replaceChildren();
    const items = memoryView?.items || [];
    if (!items.length) { target.append(el('span', 'wb-muted', '还没有长期记忆')); return; }
    for (const item of items.slice(0, 3)) {
      const line = el('p');
      line.append(el('span', 'wb-memory-tag', memorySectionLabel(item.section)), document.createTextNode(item.text));
      target.append(line);
    }
  }

  function renderRecent() {
    const target = $('wb-recent');
    if (!target) return;
    const recent = rows.filter(row => row.state === 'done').sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0)).slice(0, 4);
    target.replaceChildren();
    if (!recent.length) { target.append(el('span', 'wb-muted', '暂无完成的任务')); return; }
    for (const row of recent) {
      const item = el('div', 'wb-recent-item');
      item.append(el('b', '', titleOf(row)), el('small', '', (TOOL[row.tool] || row.tool) + ' · ' + (row.place || row.name || '') + ' · ' + ago(row.activeAt)));
      target.append(item);
    }
  }

  function renderList() {
    const target = $('wb-list');
    const list = visibleRows();
    const scroll = target.scrollTop;
    target.replaceChildren();
    if (!list.length) {
      target.append(el('div', 'wb-detail-empty', rows.length ? '这个筛选下没有任务' : '现在没有正在显示的 Codex / DSH 会话'));
      return;
    }
    for (const row of list) {
      const button = el('button', 'wb-row ' + color(row) + ' ' + row.state + (row.id === selected ? ' on' : ''));
      button.type = 'button';
      button.dataset.id = row.id;
      const main = el('span', 'wb-row-main');
      main.append(el('span', 'wb-row-title', titleOf(row)),
        el('span', 'wb-row-sub', [TOOL[row.tool] || row.tool, row.place || row.cwd || ''].filter(Boolean).join(' · ')));
      const side = el('span', 'wb-row-side');
      side.append(el('span', 'wb-row-state ' + color(row), stateText(row)), el('span', 'wb-row-tok', tokens(row.tokens)));
      button.append(dotFor(row), main, side);
      button.addEventListener('click', () => {
        selected = row.id;
        for (const item of target.querySelectorAll('.wb-row')) item.classList.toggle('on', item.dataset.id === selected);
        renderDetail();
      });
      target.append(button);
    }
    target.scrollTop = scroll;
  }

  const SECTION_PREVIEW = 600;
  function previewOf(text) {
    if (text.length <= SECTION_PREVIEW) return text;
    const head = text.slice(0, SECTION_PREVIEW);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'));
    return cut > SECTION_PREVIEW * 0.55 ? head.slice(0, cut + 1) : head;
  }
  function expandableParagraph(body, id = '') {
    const text = String(body || '');
    const paragraph = el('p', '', previewOf(text));
    if (id) paragraph.id = id;
    if (text.length <= SECTION_PREVIEW) return { paragraph, button: null };
    let expanded = false;
    const button = el('button', 'wb-quiet', '展开全文');
    button.type = 'button';
    button.addEventListener('click', () => {
      expanded = !expanded;
      paragraph.textContent = expanded ? text : previewOf(text);
      button.textContent = expanded ? '收起全文' : '展开全文';
    });
    return { paragraph, button };
  }
  function section(title, body) {
    if (!body) return null;
    const node = el('div', 'wb-section');
    node.append(el('h3', '', title));
    const content = expandableParagraph(body);
    node.append(content.paragraph);
    if (content.button) node.append(content.button);
    return node;
  }

  function stageFor(row) {
    if (row.state === 'done') return 3;
    if (['failed', 'aborted', 'timeout'].includes(row.state)) return 3;
    if (row.state === 'question' || row.state === 'permission') return 2;
    if (row.state === 'running' || row.state === 'stuck') {
      const step = Number(row.step), steps = Number(row.steps);
      if (Number.isFinite(step) && Number.isFinite(steps) && steps > 0 && step / steps >= 0.8) return 2;
      return 1;
    }
    return 0;
  }

  function stageBar(row) {
    const stage = stageFor(row);
    const labels = ['理解', '执行', '验证', '收尾'];
    const box = el('div', 'wb-stage');
    labels.forEach((label, index) => {
      const step = el('div', 'wb-stage-step' + (index < stage ? ' done' : index === stage ? ' on' : ''));
      step.append(el('i'), el('span', '', label));
      box.append(step);
    });
    box.append(el('small', '', '阶段（估算）'));
    return box;
  }

  function paintOutput(body, row) {
    const entry = outputCache.get(row.id);
    const follow = outputFollow.get(row.id) !== false;
    const scroll = outputScroll.get(row.id) || 0;
    body.replaceChildren();
    if (!entry) {
      body.append(el('div', 'wb-output-empty', '正在读取任务输出…'));
      return;
    }
    const events = Array.isArray(entry.events) ? entry.events : [];
    if (!events.length) {
      body.append(el('div', 'wb-output-empty', '这条任务还没有结构化输出。'));
      return;
    }
    const expanded = outputExpanded.has(row.id);
    const shown = expanded ? events : events.slice(-6);
    for (const event of shown) {
      const line = el('div', 'wb-output-line');
      const time = Number(event.at) ? new Date(Number(event.at)).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
      line.append(el('span', 'wb-output-time', time), el('span', 'wb-output-type', String(event.type || 'log')), el('span', 'wb-output-text', String(event.text || '')));
      body.append(line);
    }
    if (events.length > 6 || !follow) {
      const actions = el('div', 'wb-output-actions');
      if (events.length > 6) {
        const toggle = el('button', 'wb-quiet wb-output-toggle', expanded ? '收起输出' : '展开全部 ' + events.length + ' 条');
        toggle.type = 'button';
        toggle.addEventListener('click', () => {
          if (expanded) outputExpanded.delete(row.id); else outputExpanded.add(row.id);
          paintOutput(body, row);
        });
        actions.append(toggle);
      }
      if (!follow) {
        const latest = el('button', 'wb-quiet wb-output-toggle', '回到最新');
        latest.type = 'button';
        latest.addEventListener('click', () => {
          outputFollow.set(row.id, true);
          paintOutput(body, row);
        });
        actions.append(latest);
      }
      body.prepend(actions);
    }
    const restore = () => { body.scrollTop = follow ? body.scrollHeight : scroll; };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore); else restore();
  }

  function renderOutput(row) {
    const box = el('div', 'wb-output');
    const head = el('div', 'wb-output-head');
    head.append(el('h3', '', '执行输出'), el('small', '', row.taskId ? '最近 120 条 · 只读' : '观察会话'));
    box.append(head);
    const body = el('div', 'wb-output-body');
    body.addEventListener('scroll', () => {
      const bottom = body.scrollHeight - body.scrollTop - body.clientHeight < 20;
      outputFollow.set(row.id, bottom);
      if (!bottom) outputScroll.set(row.id, body.scrollTop);
    }, { passive: true });
    box.append(body);
    if (!row.taskId) {
      body.append(el('div', 'wb-output-empty', '观察会话没有逐条输出；完整回答见下面的摘要。'));
      return box;
    }
    const cached = outputCache.get(row.id);
    if (cached && Date.now() - cached.at < 5000) {
      paintOutput(body, row);
      return box;
    }
    body.append(el('div', 'wb-output-empty', '正在读取任务输出…'));
    request('/api/workbench/tasks/' + encodeURIComponent(row.taskId) + '/events').then(data => {
      if (!data?.ok) throw new Error(data?.error || '读取输出失败');
      outputCache.set(row.id, { at: Date.now(), events: data.events || [] });
      if (selected === row.id) paintOutput(body, row);
    }).catch(problem => {
      if (selected === row.id) {
        body.replaceChildren(el('div', 'wb-output-empty', problem.message || '读取输出失败'));
      }
    });
    return box;
  }

  function renderDetail() {
    const target = $('wb-detail');
    const scroll = target.scrollTop;
    const row = rows.find(item => item.id === selected) || visibleRows()[0] || null;
    target.replaceChildren();
    if (!row) {
      target.append(el('div', 'wb-detail-empty', '选一个任务看详情。'));
      return;
    }
    selected = row.id;
    target.append(el('h2', '', titleOf(row)));
    target.append(el('div', 'wb-detail-meta', [TOOL[row.tool] || row.tool, row.place || row.cwd].filter(Boolean).join(' · ')));
    const status = el('div', 'wb-detail-status');
    status.append(dotFor(row), el('span', '', stateText(row) + (row.reason ? ' · ' + row.reason : '')));
    target.append(status);

    const grid = el('div', 'wb-detail-grid');
    const add = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      const cell = el('div', 'wb-kv');
      cell.append(el('span', '', label), el('b', '', String(value)));
      grid.append(cell);
    };
    add('上下文', row.tokens === null || row.tokens === undefined ? '未统计' : tokens(row.tokens) + (Number.isFinite(row.contextPercent) ? ' · ' + Math.round(row.contextPercent) + '%' : ''));
    add('步骤', Number.isFinite(row.step) ? (row.steps ? row.step + ' / ' + row.steps : String(row.step)) : '—');
    add('最近活动', ago(row.activeAt || row.since));
    add('项目', row.name);
    add('会话', row.sessionId ? String(row.sessionId).slice(0, 18) : '');
    if (grid.childNodes.length) target.append(grid);

    if (Number.isFinite(row.contextPercent)) {
      const bar = el('div', 'wb-bar' + (row.contextPercent >= 80 ? ' full' : ''));
      const fill = el('i');
      fill.style.width = Math.max(2, Math.min(100, row.contextPercent)) + '%';
      bar.append(fill);
      target.append(bar);
    }
    target.append(stageBar(row));
    target.append(renderOutput(row));
    const prompt = section('这次交代了什么', row.prompt);
    if (prompt) target.append(prompt);
    const failure = section('错误', row.error);
    if (failure) target.append(failure);

    const summaryBox = el('div', 'wb-section');
    summaryBox.append(el('h3', '', '上一次回答'));
    const summaryEntry = summaries.get(row.id);
    const summaryText = typeof summaryEntry === 'string' ? summaryEntry : summaryEntry?.text;
    const summaryParagraph = el('p', summaryText ? '' : 'muted', summaryText || '还没有摘要。');
    summaryParagraph.id = 'wb-task-summary';
    summaryBox.append(summaryParagraph);
    const summaryButton = el('button', 'wb-secondary', summaryText ? '刷新摘要' : '生成摘要');
    summaryButton.type = 'button';
    summaryButton.addEventListener('click', () => generateSummary(row));
    summaryBox.append(summaryButton);
    target.append(summaryBox);

    if (row.taskId && row.canStop) {
      const actions = el('div', 'wb-actions');
      const stop = el('button', 'wb-secondary', pendingStop === row.taskId ? '确认停止' : '停止任务');
      stop.type = 'button';
      stop.addEventListener('click', () => stopTask(row.taskId));
      actions.append(stop);
      target.append(actions);
    }
    target.scrollTop = scroll;
  }

  function renderBoard() {
    const target = $('wb-board');
    if (!target) return;
    const list = visibleRows();
    const columns = [
      { label: '排队', test: row => row.taskStatus === 'queued' },
      { label: '运行中', test: row => row.state === 'running' || row.state === 'stuck' },
      { label: '等你处理', test: row => row.state === 'question' || row.state === 'permission' },
      { label: '完成 / 结束', test: row => row.taskStatus !== 'queued' && !['running', 'stuck', 'question', 'permission'].includes(row.state) },
    ];
    target.replaceChildren();
    for (const column of columns) {
      const items = list.filter(column.test);
      const box = el('div', 'wb-board-col');
      const head = el('div', 'wb-board-head');
      head.append(el('span', '', column.label), el('b', '', String(items.length)));
      box.append(head);
      const cards = el('div', 'wb-board-list');
      for (const row of items.slice(0, 30)) {
        const card = el('button', 'wb-board-card' + (row.id === selected ? ' on' : ''));
        card.type = 'button';
        card.append(
          el('b', '', titleOf(row)),
          el('span', '', (TOOL[row.tool] || row.tool) + ' · ' + (row.place || row.name || '')),
          el('em', '', stateText(row) + ' · ' + tokens(row.tokens)),
        );
        card.addEventListener('click', () => {
          selected = row.id;
          showView('detail');
          render();
        });
        cards.append(card);
      }
      if (!items.length) cards.append(el('div', 'wb-board-empty', '暂无'));
      box.append(cards);
      target.append(box);
    }
  }

  function renderTimeline() {
    const target = $('wb-timeline');
    if (!target) return;
    const now = Date.now(), range = timelineRange * 60 * 60 * 1000, start = now - range;
    const lanes = [
      { tool: 'codex', label: 'Codex' },
      { tool: 'dsh', label: 'DSH' },
      { tool: 'claude', label: 'Claude' },
    ];
    const list = visibleRows();
    target.replaceChildren();
    const tools = el('div', 'wb-timeline-tools');
    const rangeLabel = el('span', '', '范围');
    tools.append(rangeLabel);
    for (const hours of [1, 6, 24]) {
      const button = el('button', 'wb-quiet' + (timelineRange === hours ? ' on' : ''), hours + 'h');
      button.type = 'button';
      button.addEventListener('click', () => {
        timelineRange = hours;
        try { localStorage.setItem('wb-timeline-range', String(hours)); } catch {}
        renderTimeline();
      });
      tools.append(button);
    }
    const legend = el('div', 'wb-timeline-legend');
    for (const [state, label] of [['green', '完成/运行'], ['yellow', '等待'], ['red', '失败'], ['gray', '空闲']]) {
      const item = el('span', 'wb-timeline-legend-item');
      item.append(el('i', 'wb-timeline-dot ' + state), el('span', '', label));
      legend.append(item);
    }
    tools.append(legend);
    target.append(tools);
    const inner = el('div', 'wb-timeline-inner');
    const axis = el('div', 'wb-timeline-axis');
    axis.append(el('span', '', '最近 ' + timelineRange + ' 小时'), el('span', '', '现在'));
    inner.append(axis);
    for (const lane of lanes) {
      const rowsInLane = list.filter(row => row.tool === lane.tool);
      const line = el('div', 'wb-timeline-lane');
      const laneHeight = Math.max(44, rowsInLane.length * 17 + 10);
      line.style.minHeight = laneHeight + 'px';
      line.append(el('div', 'wb-timeline-label', lane.label + ' · ' + rowsInLane.length));
      const track = el('div', 'wb-timeline-track');
      track.style.minHeight = laneHeight + 'px';
      rowsInLane.forEach((row, index) => {
        const beginRaw = Number(row.startedAt ?? row.since ?? row.activeAt);
        if (!Number.isFinite(beginRaw)) return;
        const endRaw = row.state === 'running' || row.state === 'stuck'
          ? now : Number(row.finishedAt ?? row.activeAt ?? beginRaw);
        const begin = Math.max(start, Math.min(now, beginRaw));
        const end = Math.max(begin + 60000, Math.min(now, Number.isFinite(endRaw) ? endRaw : begin));
        if (end <= start || begin >= now) return;
        const bar = el('button', 'wb-timeline-bar ' + color(row), titleOf(row));
        bar.type = 'button';
        const widthPct = Math.max(timelineRange <= 1 ? 4 : 2.2, (end - begin) / range * 100);
        bar.style.left = Math.min((begin - start) / range * 100, 100 - widthPct).toFixed(2) + '%';
        bar.style.width = widthPct.toFixed(2) + '%';
        bar.style.top = (7 + index * 16) + 'px';
        const beginTime = new Date(begin).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const endTime = new Date(end).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
        bar.title = titleOf(row) + ' · ' + stateText(row) + ' · ' + beginTime + '–' + endTime;
        if (widthPct < 7) bar.textContent = '';
        bar.addEventListener('click', () => {
          selected = row.id;
          showView('detail');
          render();
        });
        track.append(bar);
      });
      const nowLine = el('i', 'wb-timeline-now');
      nowLine.style.right = '0';
      track.append(nowLine);
      line.append(track);
      inner.append(line);
    }
    target.append(inner);
  }

  function showView(name) {
    view = ['detail', 'board', 'timeline'].includes(name) ? name : 'detail';
    try { localStorage.setItem('wb-view', view); } catch {}
    for (const button of document.querySelectorAll('.wb-canvas-tabs button')) {
      const on = button.dataset.view === view;
      button.classList.toggle('on', on);
      button.setAttribute('aria-selected', String(on));
    }
    $('wb-detail').hidden = view !== 'detail';
    $('wb-board').hidden = view !== 'board';
    $('wb-timeline').hidden = view !== 'timeline';
    const hint = $('wb-view-hint');
    if (hint) hint.textContent = view === 'board' ? '按状态分组' : view === 'timeline' ? '最近 ' + timelineRange + ' 小时（估算）' : '当前任务';
    if (view === 'board') renderBoard();
    else if (view === 'timeline') renderTimeline();
    else renderDetail();
  }

  function render() {
    renderSummary();
    renderDrafts();
    renderList();
    renderDetail();
    if (view === 'board') renderBoard();
    else if (view === 'timeline') renderTimeline();
    renderPulse();
    renderRecent();
    syncChatTaskCards();
    renderRightMemory();
  }

  async function refresh() {
    clearTimeout(timer);
    if (document.hidden) { timer = setTimeout(refresh, POLL_MS); return; }
    try {
      const data = await request('/api/workbench/tasks');
      rows = Array.isArray(data.rows) ? data.rows : [];
      counts = data.counts || {};
      dsh = data.dsh || null;
      drafts = Array.isArray(data.drafts) ? data.drafts : [];
      runnerInfo = data.runner || null;
      limits = data.limits || null;
      showError('');
      if (!rows.some(row => row.id === selected)) selected = visibleRows()[0]?.id || '';
      render();
    } catch (problem) {
      showError(problem.message || '工作台数据暂时读不到');
    }
    timer = setTimeout(refresh, POLL_MS);
  }

  async function generateSummary(row) {
    try {
      const data = await request('/api/workbench/tasks/summary', 'POST', { id: row.id, refresh: summaries.has(row.id) });
      summaries.set(row.id, { text: data.text || '', source: data.source || {} });
      renderDetail();
      toast(data.cached ? '已使用缓存摘要' : '摘要已生成');
    } catch (problem) { toast(problem.message || '没能生成摘要'); }
  }

  async function showReport(refresh = false) {
    const dialog = $('wb-report');
    if (!dialog.open) dialog.showModal();
    $('wb-report-day').textContent = refresh ? '正在重新生成…' : '正在读取今天…';
    $('wb-report-body').textContent = '正在生成…';
    $('wb-report-status').textContent = '';
    try {
      const data = await request('/api/workbench/report', 'POST', { refresh });
      $('wb-report-day').textContent = data.day || '';
      $('wb-report-body').textContent = data.text || '今天没有可复盘的内容。';
      $('wb-report-status').textContent = data.cached ? '来自缓存' : data.fallback ? '本地摘要（模型未返回）' : '已生成';
    } catch (problem) {
      $('wb-report-body').textContent = problem.message || '没能生成复盘';
      $('wb-report-status').textContent = '';
    }
  }

  function memorySectionLabel(section) { return memoryView?.sections?.[section] || section; }
  function resetPending() {
    pendingForget = ''; pendingImport = false; pendingClear = false;
    clearTimeout(pendingTimer); pendingTimer = null;
    renderMemory();
  }
  function armPending(kind, id = '') {
    pendingForget = kind === 'forget' ? id : '';
    pendingImport = kind === 'import';
    pendingClear = kind === 'clear';
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(resetPending, 4000);
    renderMemory();
  }
  function renderMemory() {
    const target = $('wb-memory-list');
    target.replaceChildren();
    const view = memoryView;
    if (!view) {
      $('wb-memory-budget').textContent = '还没有读取记忆';
      target.append(el('div', 'wb-memory-empty', '点“立即整理”或“从历史初始化”，或者直接在下面记一条。'));
      renderRightMemory();
      return;
    }
    const budget = view.budget || {};
    $('wb-memory-budget').textContent = '记忆 ' + (budget.items || 0) + ' / ' + (budget.itemLimit || 40) + ' 条 · ' +
      ((budget.bytes || 0) / 1024).toFixed(1) + ' / 4 KB';
    $('wb-memory-import').textContent = pendingImport ? '确认从历史初始化' : '从历史初始化';
    $('wb-memory-clear').textContent = pendingClear ? '确认清空' : '清空';
    const groups = new Map(Object.keys(view.sections || {}).map(section => [section, []]));
    for (const item of view.items || []) {
      if (!groups.has(item.section)) groups.set(item.section, []);
      groups.get(item.section).push(item);
    }
    let shown = 0;
    for (const [section, list] of groups) {
      if (!list.length) continue;
      target.append(el('div', 'wb-memory-section', memorySectionLabel(section)));
      for (const item of list) {
        shown += 1;
        const row = el('div', 'wb-memory-item');
        const main = el('div', 'wb-memory-item-main');
        if (editingId === item.id) {
          const area = document.createElement('textarea');
          area.value = item.text; area.maxLength = 160; area.rows = 2;
          const actions = el('div', 'wb-memory-item-actions');
          const save = el('button', '', '保存');
          save.type = 'button';
          save.addEventListener('click', async () => {
            try { await memoryRequest('update', { id: item.id, text: area.value }); editingId = ''; renderMemory(); }
            catch (problem) { toast(problem.message || '没能保存'); }
          });
          const cancel = el('button', '', '取消');
          cancel.type = 'button';
          cancel.addEventListener('click', () => { editingId = ''; renderMemory(); });
          actions.append(save, cancel);
          main.append(area);
          row.append(main, actions);
        } else {
          const line = el('p', '', item.text);
          main.append(line);
          if (item.pinned) main.append(el('span', 'wb-memory-pin', '重要'));
          const actions = el('div', 'wb-memory-item-actions');
          const pin = el('button', '', item.pinned ? '取消重要' : '重要');
          pin.type = 'button';
          pin.addEventListener('click', () => memoryRequest('update', { id: item.id, pinned: !item.pinned }).catch(problem => toast(problem.message || '没能更新')));
          const edit = el('button', '', '编辑');
          edit.type = 'button';
          edit.addEventListener('click', () => { editingId = item.id; renderMemory(); });
          const forget = el('button', 'danger', pendingForget === item.id ? '确认忘掉' : '忘掉');
          forget.type = 'button';
          forget.addEventListener('click', () => {
            if (pendingForget !== item.id) { armPending('forget', item.id); return; }
            pendingForget = ''; clearTimeout(pendingTimer);
            memoryRequest('forget', { id: item.id }).then(() => toast('已忘掉')).catch(problem => toast(problem.message || '没能忘掉'));
          });
          actions.append(pin, edit, forget);
          row.append(main, actions);
        }
        target.append(row);
      }
    }
    if (!shown) target.append(el('div', 'wb-memory-empty', '还没有长期记忆。可以主动告诉大肥鱼“以后……”，或在下面添加一条。'));
    renderRightMemory();
  }

  async function loadMemory() {
    const errorNode = $('wb-memory-error');
    try {
      const data = await request('/api/workbench/memory');
      memoryView = data.memory;
      memoryLoaded = true;
      const select = $('wb-memory-section');
      if (!select.options.length) {
        for (const [value, label] of Object.entries(memoryView.sections || {})) {
          const option = document.createElement('option');
          option.value = value; option.textContent = label;
          select.append(option);
        }
      }
      errorNode.hidden = true;
      renderMemory();
    } catch (problem) {
      errorNode.textContent = problem.message || '记忆暂时读不到';
      errorNode.hidden = false;
    }
  }

  async function memoryRequest(action, payload = {}) {
    const data = await request('/api/workbench/memory', 'POST', { action, ...payload });
    if (data.memory) { memoryView = data.memory; renderMemory(); }
    return data;
  }

  async function addMemory(event) {
    event.preventDefault();
    const text = $('wb-memory-text').value.trim();
    if (!text) return;
    try {
      await memoryRequest('save', { section: $('wb-memory-section').value, text, pinned: $('wb-memory-pinned').checked });
      $('wb-memory-text').value = '';
      $('wb-memory-pinned').checked = false;
      toast('记住了');
    } catch (problem) { toast(problem.message || '没能记住'); }
  }

  async function consolidateMemory() {
    try {
      const data = await request('/api/workbench/memory/consolidate', 'POST');
      if (data.memory) { memoryView = data.memory; renderMemory(); }
      toast('整理完成');
    } catch (problem) { toast(problem.message || '现在不能整理'); }
  }

  async function importMemory() {
    if (!pendingImport) { armPending('import'); return; }
    pendingImport = false; clearTimeout(pendingTimer);
    try {
      const data = await request('/api/workbench/memory/import', 'POST');
      if (data.memory) { memoryView = data.memory; renderMemory(); }
      toast('已从历史对话初始化');
    } catch (problem) { toast(problem.message || '没能初始化'); }
  }

  async function clearMemory() {
    if (!pendingClear) { armPending('clear'); return; }
    pendingClear = false; clearTimeout(pendingTimer);
    try {
      await memoryRequest('clear');
      toast('记忆已清空');
    } catch (problem) { toast(problem.message || '没能清空'); }
  }

  function chatTime(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
  }
  function chatBubble(role, text, meta = '', extra = '') {
    const node = el('div', 'wb-msg ' + role + (extra ? ' ' + extra : ''));
    if (meta) node.append(el('span', 'wb-msg-meta', meta));
    node.append(document.createTextNode(text));
    return node;
  }
  function chatTaskCards(refs) {
    const box = el('div', 'wb-chat-task-cards');
    for (const ref of refs.slice(0, 3)) {
      const row = rows.find(item => item.taskId === ref.id || item.id === ref.id);
      const card = el('div', 'wb-chat-task');
      card.dataset.ref = ref.id;
      const main = el('button', 'wb-chat-task-main');
      main.type = 'button';
      main.append(
        el('b', '', row ? titleOf(row) : ref.title || ref.id),
        el('span', 'wb-chat-task-status', (TOOL[row?.tool || ref.tool] || ref.tool || '任务') + ' · ' + (row ? stateText(row) : taskStatusLabel(ref.status))),
      );
      main.addEventListener('click', () => {
        if (!row) return toast('这个任务已经不在当前列表里');
        selected = row.id;
        showView('detail');
        render();
      });
      card.append(main);
      if (row) {
        const summary = el('button', 'wb-quiet wb-chat-task-action', '摘要');
        summary.type = 'button';
        summary.addEventListener('click', () => {
          selected = row.id;
          showView('detail');
          generateSummary(row);
        });
        card.append(summary);
      }
      box.append(card);
    }
    return box;
  }

  function syncChatTaskCards() {
    for (const card of document.querySelectorAll('.wb-chat-task[data-ref]')) {
      const row = rows.find(item => item.taskId === card.dataset.ref || item.id === card.dataset.ref);
      if (!row) continue;
      const title = card.querySelector('.wb-chat-task-main b');
      const status = card.querySelector('.wb-chat-task-status');
      if (title) title.textContent = titleOf(row);
      if (status) status.textContent = (TOOL[row.tool] || row.tool || '任务') + ' · ' + stateText(row);
    }
  }

  function renderChat() {
    const target = $('wb-chat-log');
    if (!target) return;
    const stick = target.scrollHeight - target.scrollTop - target.clientHeight < 60;
    target.replaceChildren();
    const turns = chatTurns.slice(-40);
    for (const turn of turns) {
      if (turn.user) target.append(chatBubble('user', turn.user, '你 · ' + chatTime(turn.createdAt)));
      const streaming = turn.status === 'streaming';
      if (turn.text || streaming) {
        target.append(chatBubble('assistant', turn.text || '…', '本鱼 · ' + chatTime(turn.createdAt), streaming ? 'streaming' : ''));
      }
      if (turn.error) target.append(chatBubble('error', turn.error, '错误'));
      if (Array.isArray(turn.taskRefs) && turn.taskRefs.length) target.append(chatTaskCards(turn.taskRefs));
    }
    if (!turns.length) target.append(el('div', 'wb-chat-empty', '和本鱼说点什么。它会记得长期偏好，也能帮你查看和下发任务。'));
    if (stick) target.scrollTop = target.scrollHeight;
    if (chatConversationId) $('wb-chat-status').textContent = '共享当前角色会话';
  }
  function renderChatConversations() {
    const select = $('wb-chat-conversations');
    if (!select) return;
    select.replaceChildren();
    for (const conversation of chatConversations) {
      const option = document.createElement('option');
      option.value = conversation.id;
      option.textContent = conversation.title || '未命名会话';
      select.append(option);
    }
    if (chatConversationId) select.value = chatConversationId;
  }
  async function loadChat() {
    try {
      const data = await chat.history();
      chatTurns = Array.isArray(data.turns) ? data.turns : [];
      chatConversationId = data.conversationId || '';
      chatConversations = Array.isArray(data.conversations) ? data.conversations : [];
      renderChatConversations();
      renderChat();
    } catch (problem) {
      chatTurns = [];
      $('wb-chat-log').replaceChildren(el('div', 'wb-chat-empty', problem.message || '会话暂时读不到'));
    }
  }
  function setChatBusy(busy) {
    chatGenerating = !!busy;
    if ($('wb-chat-send')) $('wb-chat-send').disabled = !!busy;
    if ($('wb-chat-stop')) $('wb-chat-stop').hidden = !busy;
  }
  async function sendChat(event) {
    event.preventDefault();
    if (chatGenerating) return;
    const input = $('wb-chat-input'), text = input.value.trim();
    if (!text) return;
    const id = 'wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    input.value = '';
    setChatBusy(true);
    chatActiveId = id;
    chatTurns.push({ id, user: text, text: '', status: 'streaming', createdAt: new Date().toISOString() });
    renderChat();
    try {
      await chat.send(id, text, message => {
        const last = chatTurns[chatTurns.length - 1];
        if (!last) return;
        if (message.type === 'delta') { last.text += message.text; renderChat(); }
        else if (message.type === 'done') { chatTurns[chatTurns.length - 1] = message.turn; renderChat(); }
      }, chatConversationId);
    } catch (problem) {
      const last = chatTurns[chatTurns.length - 1];
      if (last) { last.status = 'failed'; last.error = problem.message || '发送失败'; }
      renderChat();
    } finally {
      chatActiveId = '';
      setChatBusy(false);
    }
  }
  async function stopChat() {
    if (!chatGenerating || !chatActiveId) return;
    try { await chat.stop(chatActiveId); $('wb-chat-status').textContent = '正在停止…'; }
    catch (problem) { toast(problem.message || '没能停止'); }
  }
  async function newChat() {
    if (chatGenerating) return;
    try { await chat.createConversation(); await loadChat(); showTab('tasks'); toast('新会话'); }
    catch (problem) { toast(problem.message || '没能新建会话'); }
  }
  async function selectChatConversation(event) {
    if (chatGenerating) { event.target.value = chatConversationId; toast('请先停止当前回复'); return; }
    try { await chat.selectConversation(event.target.value); await loadChat(); }
    catch (problem) { event.target.value = chatConversationId; toast(problem.message || '没能切换会话'); }
  }

  function applyWallpaper(value) {
    if (value) document.documentElement.style.setProperty('--wallpaper', 'url("' + value + '")');
    else document.documentElement.style.removeProperty('--wallpaper');
  }
  function loadWallpaper() {
    try { const saved = localStorage.getItem('wb-wallpaper'); if (saved) applyWallpaper(saved); } catch {}
  }

  function startWallpaperParallax() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let x = 0, y = 0, frame = 0;
    window.addEventListener('pointermove', event => {
      x = ((event.clientX / Math.max(1, window.innerWidth)) - .5) * 6;
      y = ((event.clientY / Math.max(1, window.innerHeight)) - .5) * 4;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--wallpaper-x', x.toFixed(2) + 'px');
        document.documentElement.style.setProperty('--wallpaper-y', y.toFixed(2) + 'px');
        frame = 0;
      });
    }, { passive: true });
  }
  function chooseWallpaper() { $('wb-wallpaper-input').click(); }
  function readWallpaper(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    if (file.size > 3 * 1024 * 1024) { toast('图片请小于 3 MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      if (!value.startsWith('data:image/')) { toast('图片读取失败'); return; }
      applyWallpaper(value);
      try { localStorage.setItem('wb-wallpaper', value); } catch { toast('图片太大，无法保存'); }
    };
    reader.onerror = () => toast('图片读取失败');
    reader.readAsDataURL(file);
  }
  function clearWallpaper() {
    applyWallpaper('');
    try { localStorage.removeItem('wb-wallpaper'); } catch {}
    toast('已恢复纯黑背景');
  }

  function paletteCommands() {
    const row = rows.find(item => item.id === selected) || null;
    const commands = [
      { group: '视图', title: '详情', hint: '当前任务', run: () => showView('detail') },
      { group: '视图', title: '看板', hint: '按状态分组', run: () => showView('board') },
      { group: '视图', title: '时间轴', hint: '最近 6 小时', run: () => showView('timeline') },
      { group: '页面', title: '任务', hint: '返回任务页', run: () => showTab('tasks') },
      { group: '页面', title: '长期记忆', hint: '编辑记忆', run: () => showTab('memory') },
      { group: '页面', title: '设置', hint: '下发设置', run: () => showTab('settings') },
      { group: '操作', title: '刷新任务', hint: '重新读取', run: () => refresh() },
      { group: '操作', title: '今日复盘', hint: '生成日报', run: () => showReport(false) },
    ];
    if (row) {
      commands.push({ group: '当前任务', title: '生成 / 刷新摘要', hint: titleOf(row), run: () => generateSummary(row) });
      if (row.taskId && row.canStop) {
        commands.push({ group: '当前任务', title: '停止任务', hint: titleOf(row), run: () => stopTask(row.taskId) });
      }
    }
    for (const item of visibleRows().slice(0, 40)) {
      commands.push({
        group: '任务', title: titleOf(item), hint: (TOOL[item.tool] || item.tool) + ' · ' + stateText(item),
        run: () => {
          selected = item.id;
          showView('detail');
          render();
          const listItem = document.querySelector('#wb-list [data-id="' + CSS.escape(item.id) + '"]');
          listItem?.scrollIntoView({ block: 'nearest' });
        },
      });
    }
    return commands;
  }

  function closePalette(restore = true) {
    const overlay = $('wb-palette');
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    $('wb-palette-list').replaceChildren();
    if (restore && paletteReturnFocus && typeof paletteReturnFocus.focus === 'function') {
      try { paletteReturnFocus.focus(); } catch {}
    }
    paletteReturnFocus = null;
  }

  function renderPalette() {
    const list = $('wb-palette-list');
    const query = $('wb-palette-input').value.trim().toLowerCase();
    const all = paletteCommands();
    paletteResults = query
      ? all.filter(command => (command.title + ' ' + command.hint + ' ' + command.group).toLowerCase().includes(query))
      : all;
    paletteIndex = Math.max(0, Math.min(paletteIndex, paletteResults.length - 1));
    list.replaceChildren();
    if (!paletteResults.length) {
      list.append(el('div', 'wb-palette-none', '没有匹配的命令'));
      return;
    }
    let lastGroup = '';
    paletteResults.forEach((command, index) => {
      if (command.group !== lastGroup) {
        lastGroup = command.group;
        list.append(el('div', 'wb-palette-group', command.group));
      }
      const item = el('button', 'wb-palette-item' + (index === paletteIndex ? ' on' : ''));
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === paletteIndex));
      item.append(el('span', '', command.title), el('small', '', command.hint || ''));
      item.addEventListener('mouseenter', () => {
        paletteIndex = index;
        for (const [i, button] of [...list.querySelectorAll('.wb-palette-item')].entries()) {
          button.classList.toggle('on', i === index);
          button.setAttribute('aria-selected', String(i === index));
        }
      });
      item.addEventListener('click', () => runPalette(index));
      list.append(item);
    });
    list.querySelector('.wb-palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function runPalette(index) {
    const command = paletteResults[index];
    if (!command) return;
    closePalette(false);
    try { command.run(); } catch {}
  }

  function openPalette() {
    const overlay = $('wb-palette');
    if (!overlay || !overlay.hidden) return;
    paletteReturnFocus = document.activeElement;
    overlay.hidden = false;
    const input = $('wb-palette-input');
    input.value = '';
    paletteIndex = 0;
    renderPalette();
    input.focus();
  }

  function showTab(name) {
    for (const button of document.querySelectorAll('.wb-tabs button')) {
      const on = button.dataset.tab === name;
      button.classList.toggle('on', on);
      button.setAttribute('aria-selected', String(on));
    }
    const cockpit = document.querySelector('.wb-cockpit');
    if (cockpit) cockpit.hidden = name !== 'tasks';
    for (const panel of document.querySelectorAll('.wb-panel')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'settings' && !settingsLoaded) loadSettings();
    if (name === 'memory' && !memoryLoaded) loadMemory();
    if (name === 'tasks') showView(view);
  }

  function fillSettings(value) {
    settings = value;
    $('wb-roots').value = (value.allowedRoots || []).join('\n');
    $('wb-read-content').checked = value.readTaskContent !== false;
    $('wb-confirm').checked = value.confirmDispatch !== false;
    $('wb-auto-memory').checked = value.autoConsolidate !== false;
    $('wb-concurrent').value = String(value.maxConcurrent || 2);
    $('wb-timeout').value = String(value.taskTimeoutMinutes || 30);
    $('wb-sandbox').value = value.codexSandbox || 'workspace-write';
    $('wb-digest').value = value.dailyDigest || '';
  }

  async function loadSettings() {
    try {
      const data = await request('/api/workbench/settings');
      fillSettings(data.settings || {});
      settingsLoaded = true;
      $('wb-settings-status').textContent = '';
    } catch (problem) {
      $('wb-settings-status').textContent = problem.message || '设置读不到';
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const status = $('wb-settings-status');
    status.textContent = '正在保存…';
    try {
      const data = await request('/api/workbench/settings', 'PUT', {
        allowedRoots: $('wb-roots').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean),
        readTaskContent: $('wb-read-content').checked,
        confirmDispatch: $('wb-confirm').checked,
        autoConsolidate: $('wb-auto-memory').checked,
        maxConcurrent: Number($('wb-concurrent').value),
        taskTimeoutMinutes: Number($('wb-timeout').value),
        codexSandbox: $('wb-sandbox').value,
        dailyDigest: $('wb-digest').value,
      });
      fillSettings(data.settings || {});
      status.textContent = '已保存';
      toast('设置已保存');
    } catch (problem) {
      status.textContent = problem.message || '没能保存';
    }
  }

  function start() {
    $('wb-refresh').addEventListener('click', () => { refresh(); if (settingsLoaded) loadSettings(); if (memoryLoaded) loadMemory(); });
    $('wb-memory-add').addEventListener('submit', addMemory);
    $('wb-memory-consolidate').addEventListener('click', consolidateMemory);
    $('wb-memory-import').addEventListener('click', importMemory);
    $('wb-memory-clear').addEventListener('click', clearMemory);
    $('wb-report-open').addEventListener('click', () => showReport(false));
    $('wb-right-memory-open').addEventListener('click', () => showTab('memory'));
    $('wb-report-refresh').addEventListener('click', () => showReport(true));
    $('wb-report-close').addEventListener('click', () => $('wb-report').close());
    $('wb-palette-open').addEventListener('click', openPalette);
    $('wb-palette').addEventListener('mousedown', event => { if (event.target === $('wb-palette')) closePalette(); });
    $('wb-palette-input').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
    $('wb-palette-input').addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!paletteResults.length) return;
        paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + paletteResults.length) % paletteResults.length;
        renderPalette();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        runPalette(paletteIndex);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closePalette();
      }
    });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if ($('wb-palette').hidden) openPalette(); else closePalette();
      } else if (event.key === 'Escape' && !$('wb-palette').hidden) {
        event.preventDefault();
        closePalette();
      }
    });
    document.querySelector('.wb-canvas-tabs').addEventListener('click', event => {
      const button = event.target.closest('button[data-view]');
      if (button) showView(button.dataset.view);
    });
    $('wb-wallpaper-pick').addEventListener('click', chooseWallpaper);
    $('wb-wallpaper-input').addEventListener('change', readWallpaper);
    $('wb-wallpaper-clear').addEventListener('click', clearWallpaper);
    loadWallpaper();
    startWallpaperParallax();
    $('wb-chat-form').addEventListener('submit', sendChat);
    $('wb-chat-stop').addEventListener('click', stopChat);
    $('wb-chat-new').addEventListener('click', newChat);
    $('wb-chat-conversations').addEventListener('change', selectChatConversation);
    $('wb-chat-input').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('wb-chat-form').requestSubmit(); }
    });
    $('wb-chat-input').addEventListener('input', event => {
      event.target.style.height = 'auto';
      event.target.style.height = Math.min(96, event.target.scrollHeight) + 'px';
    });
    for (const button of document.querySelectorAll('[data-window]')) {
      button.addEventListener('click', () => window.whaleWorkbench?.command(button.dataset.window));
    }
    $('wb-filters').addEventListener('click', event => {
      const button = event.target.closest('button[data-filter]');
      if (!button) return;
      filter = button.dataset.filter;
      for (const item of document.querySelectorAll('#wb-filters button')) item.classList.toggle('on', item === button);
      selected = visibleRows()[0]?.id || '';
      render();
    });
    document.querySelector('.wb-tabs').addEventListener('click', event => {
      const button = event.target.closest('button[data-tab]');
      if (button) showTab(button.dataset.tab);
    });
    $('wb-settings').addEventListener('submit', saveSettings);
    const tick = () => { const clock = $('wb-clock'); if (clock) clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); };
    tick(); setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); if (!chatGenerating) loadChat(); } });
    try {
      const savedView = localStorage.getItem('wb-view');
      if (['detail', 'board', 'timeline'].includes(savedView)) view = savedView;
      const savedRange = Number(localStorage.getItem('wb-timeline-range'));
      if ([1, 6, 24].includes(savedRange)) timelineRange = savedRange;
    } catch {}
    showView(view);
    loadMemory();
    loadChat();
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
