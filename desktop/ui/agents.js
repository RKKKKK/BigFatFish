// The task window: a small panel that stays on screen with one row per Claude
// Code or Codex session — a status dot, the tool, the project, what it is
// doing and the tokens its conversation holds. A click on a row goes to that
// session's Ghostty tab or Codex thread; swiping a row sideways removes it. It
// is pinned to a side of the screen or follows the pet, and folds into a strip
// of dots against the side it is pinned to. Its settings are kept as
// dshw-agents, which the desktop saves with the rest of ui-state.
(() => {
  'use strict';
  const KEY = 'dshw-agents', POLL_MS = 2000, CARD_WIDTH = 268, CARD_DELAY = 300, SWIPE_PX = 90;
  const STATE_TEXT = { running: '处理中', done: '完成', question: '提问', permission: '要权限', stuck: '卡住', failed: '出错', aborted: '中断', idle: '空闲' };
  const TOOL_NAME = { claude: 'Claude Code', codex: 'Codex CLI', dsh: 'DSH' };
  const SVG = 'http://www.w3.org/2000/svg';
  // Claude Code's pixel crab (Clawd), each pixel one wide and two tall.
  const CRAB = '<g fill="#d97757"><rect x="3" y="0" width="12" height="2"/><rect x="3" y="2" width="2" height="2"/><rect x="6" y="2" width="6" height="2"/><rect x="13" y="2" width="2" height="2"/><rect x="1" y="4" width="16" height="2"/><rect x="3" y="6" width="12" height="2"/><rect x="4" y="8" width="1" height="2"/><rect x="6" y="8" width="1" height="2"/><rect x="11" y="8" width="1" height="2"/><rect x="13" y="8" width="1" height="2"/></g><g fill="#1d1b1a"><rect x="5" y="2" width="1" height="2"/><rect x="12" y="2" width="1" height="2"/></g>';
  // The white knot of ChatGPT and Codex, drawn as six turned strokes.
  const KNOT = '<g fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">' +
    [0, 60, 120, 180, 240, 300].map(turn => '<path d="M -4.2 -2.4 L -4.2 -6.4 A 4.6 4.6 0 0 1 4.4 -7.2 L 4.4 0.9" transform="rotate(' + turn + ')"/>').join('') + '</g>';
  // DSH's mark: a small whale with a fin, in the blue of its app icon.
  const DSH = '<g fill="none" stroke="#4d9bff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12c2.8 0 3.4-5 7-5 3.2 0 5 2.4 5 5 0 2.8-2.4 4.6-5.6 4.6-3.4 0-5.4-1.8-5.4-4.6Z"/><path d="M14 7l4-2v6"/><circle cx="7.5" cy="10" r="1" fill="#4d9bff" stroke="none"/></g>';
  const ICONS = { pin: '<path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/>', fold: '<path d="M6 12h12"/>', jump: '<path d="M7 17L17 7M9 7h8v8"/>',
    workbench: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>' };

  // A pinned panel keeps its distance from one side of the screen, so folding
  // or growing leaves that edge where it is.
  let settings = { on: true, mode: 'pin', folded: false, side: 'right', edge: 16, y: 44 };
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
  let data = null, timer = null, hoverId = '', hideTimer = null, cardTimer = null, followTimer = null, panel = null, card = null, busy = false;
  // A rebuild under a press would swallow the click, and one under a drag or a swipe would end it.
  let pressed = false, dragging = false, swiping = false, deferred = false, shownKey = '';
  // Rows swiped away, left out until the next list confirms they are hidden.
  const gone = new Set();
  // Where the pointer last moved. Rows that slide under a still pointer as the
  // list changes are not something the user pointed at.
  let pointer = null, pointerMoved = false, wheelQuietUntil = 0;
  document.addEventListener('mousemove', event => {
    pointerMoved = !pointer || pointer.x !== event.clientX || pointer.y !== event.clientY;
    pointer = { x: event.clientX, y: event.clientY };
  }, true);

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function svg(markup, viewBox, className) {
    const node = document.createElementNS(SVG, 'svg');
    node.setAttribute('viewBox', viewBox);
    node.setAttribute('aria-hidden', 'true');
    if (className) node.setAttribute('class', className);
    node.innerHTML = markup;
    return node;
  }
  const icon = name => svg(ICONS[name], '0 0 24 24', 'agents-ico');
  function toolIcon(row) {
    const holder = element('span', 'agents-tool ' + row.tool);
    holder.append(row.tool === 'claude' ? svg(CRAB, '0 0 18 10') : row.tool === 'dsh' ? svg(DSH, '0 0 20 20') : svg(KNOT, '-12 -12 24 24'));
    if (row.app) holder.append(element('span', 'agents-app', 'APP'));
    return holder;
  }
  function dot(row) {
    const node = element('i', 'agents-dot ' + row.color);
    if (row.state === 'running') node.classList.add('busy');
    else if (row.color === 'red' || row.color === 'yellow') node.classList.add('alert');
    return node;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} }
  const toast = message => window.whaleToast?.(message);
  async function request(route, body) {
    const response = await fetch(route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return response.json().catch(() => ({ ok: false }));
  }

  // 38.2k under a hundred thousand, 126k above it, 1.2M past a million.
  function tokens(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    if (value < 1000) return String(Math.round(value));
    if (value < 100000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (value < 1e6) return Math.round(value / 1000) + 'k';
    return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  function span(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return minutes + 'm';
    const hours = Math.floor(minutes / 60);
    return hours + 'h' + (minutes % 60 ? minutes % 60 + 'm' : '');
  }
  function words(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return '不到 1 分钟';
    if (minutes < 60) return minutes + ' 分钟';
    return Math.floor(minutes / 60) + ' 小时' + (minutes % 60 ? ' ' + minutes % 60 + ' 分钟' : '');
  }
  function stateText(row, now) {
    const label = STATE_TEXT[row.state] || '';
    return ['running', 'stuck'].includes(row.state) && now - row.since >= 60000 ? label + ' ' + span(now - row.since) : label;
  }
  function stateSentence(row, now) {
    const held = words(now - row.since);
    return {
      running: '处理中，已经 ' + held,
      done: held + '前正常结束',
      question: '在问你问题，等了 ' + held,
      permission: '要你批准一个操作，等了 ' + held,
      stuck: held + '没有新进展',
      failed: held + '前出错停下了',
      aborted: held + '前被中断了',
      idle: '空闲，上次有动静是 ' + held + '前',
    }[row.state] || '';
  }
  const remaining = window => Number.isFinite(window?.remainingPercent) ? Math.round(window.remainingPercent) : null;
  // When the conversation's tokens are not known yet, the tool's own 5h quota stands in.
  function tokenCell(row) {
    const cell = element('span', 'agents-tok');
    if (Number.isFinite(row.tokens)) {
      cell.textContent = tokens(row.tokens);
      if (row.contextPercent >= 80) cell.classList.add('full');
      return cell;
    }
    const left = remaining(data?.limits?.[row.tool]?.fiveHour);
    cell.classList.add('quota');
    cell.textContent = left === null ? '' : '5h ' + left + '%';
    return cell;
  }

  function build() {
    if (panel) return;
    panel = element('section', 'agents-mini');
    panel.setAttribute('aria-label', '任务小窗');
    card = element('div', 'agents-detail');
    card.hidden = true;
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    card.addEventListener('mouseleave', scheduleHide);
    for (const node of [panel, card]) node.addEventListener('pointerdown', () => { pressed = true; }, true);
    document.body.append(panel, card);
  }
  window.addEventListener('pointerup', () => { pressed = false; if (deferred) render(); });
  window.addEventListener('pointercancel', () => { pressed = false; });
  // What the panel shows, to rebuild it only when that changes: the times are
  // shown to the minute.
  const showing = rows => JSON.stringify([settings, Math.floor(Date.now() / 60000), data?.limits, data?.claude,
    rows.map(row => [row.id, row.state, row.since, row.tokens, row.contextPercent, row.name, row.app])]);
  function render({ force = false } = {}) {
    if (!settings.on) { panel?.remove(); card?.remove(); panel = card = null; shownKey = ''; return; }
    if (pressed || dragging || swiping) { deferred = true; return; }
    deferred = false;
    const now = Date.now(), rows = (data?.rows || []).filter(row => !gone.has(row.id)), key = showing(rows);
    if (panel && !force && key === shownKey) return;
    shownKey = key;
    build();
    panel.classList.toggle('agents-folded', !!settings.folded);
    panel.classList.toggle('agents-follow', settings.mode === 'follow');
    panel.replaceChildren(...(settings.folded ? folded(rows) : unfolded(rows, now)));
    place();
    // The card stays only while the pointer is still on its row.
    const anchor = hoverId && !settings.folded ? panel.querySelector('.agents-row[data-id="' + CSS.escape(hoverId) + '"]') : null;
    const box = anchor?.getBoundingClientRect();
    if (box && pointer && pointer.x >= box.left && pointer.x < box.right && pointer.y >= box.top && pointer.y < box.bottom) { if (!card.hidden) showCard(hoverId); }
    else { hoverId = ''; mark(); hideCard(); }
  }
  function unfolded(rows, now) {
    const head = element('header', 'agents-head'), counts = element('span', 'agents-counts');
    head.append(element('strong', '', '任务'), counts);
    for (const color of ['red', 'yellow', 'green']) {
      const count = rows.filter(row => row.color === color).length;
      if (!count) continue;
      const item = element('span');
      item.append(element('i', 'agents-dot ' + color), document.createTextNode(String(count)));
      counts.append(item);
    }
    if (!rows.some(row => row.color !== 'gray')) counts.append(element('em', '', '空闲'));
    const pin = element('button', 'agents-btn' + (settings.mode === 'pin' ? ' on' : ''));
    Object.assign(pin, { type: 'button', title: settings.mode === 'pin' ? '钉在屏幕上；点一下改为跟着大肥鱼' : '跟着大肥鱼；点一下钉在屏幕上' });
    pin.setAttribute('aria-label', '钉住位置');
    pin.append(icon('pin'));
    pin.addEventListener('click', () => { settings.mode = settings.mode === 'pin' ? 'follow' : 'pin'; save(); follow(); render(); });
    const fold = element('button', 'agents-btn');
    Object.assign(fold, { type: 'button', title: '收起成一列点' });
    fold.setAttribute('aria-label', '收起');
    fold.append(icon('fold'));
    fold.addEventListener('click', () => { settings.folded = true; save(); render(); });
    const openWorkbench = element('button', 'agents-btn');
    openWorkbench.type = 'button';
    openWorkbench.title = '打开工作台';
    openWorkbench.setAttribute('aria-label', '打开工作台');
    openWorkbench.append(icon('workbench'));
    openWorkbench.addEventListener('click', () => { window.whaleDesktop?.command?.('workbench'); });
    head.append(openWorkbench, pin, fold);
    head.addEventListener('pointerdown', startDrag);
    const list = element('div', 'agents-rows');
    for (const row of rows) list.append(rowButton(row, now));
    const parts = [head, list];
    if (!rows.length) parts.push(element('div', 'agents-empty', '没有打开的会话'));
    if (data?.claude?.installed && !data.claude.tracking) parts.push(claudeNotice());
    parts.push(footer());
    return parts;
  }
  function rowButton(row, now) {
    const quiet = row.state === 'done' || row.state === 'idle' ? ' ' + row.state : '';
    const button = element('button', 'agents-row' + quiet + (row.id === hoverId ? ' agents-hover' : ''));
    button.type = 'button';
    button.dataset.id = row.id;
    button.setAttribute('aria-label', [row.name, toolName(row), stateSentence(row, now)].join('，'));
    button.append(dot(row), toolIcon(row), element('span', 'agents-proj', row.name),
      element('span', 'agents-state ' + row.color, stateText(row, now)), tokenCell(row));
    button.addEventListener('click', () => jump(row.id));
    // The card opens once the pointer has moved onto the row and rests there.
    button.addEventListener('mousemove', () => {
      if (!pointerMoved || swiping) return;
      clearTimeout(hideTimer); clearTimeout(cardTimer);
      if (hoverId !== row.id) { hoverId = row.id; mark(); hideCard(); }
      cardTimer = setTimeout(() => { if (hoverId === row.id && !swiping) showCard(row.id); }, CARD_DELAY);
    });
    button.addEventListener('mouseleave', () => { clearTimeout(cardTimer); scheduleHide(); });
    swipeable(button, row);
    return button;
  }
  // Swiping a row sideways removes it until its session does something new:
  // a drag with the mouse, or two fingers across a trackpad.
  function swipeable(button, row) {
    let start = null, dx = 0, wheelTimer = null, swipedAt = 0;
    const slide = x => {
      dx = x;
      button.style.transform = 'translateX(' + x + 'px)';
      button.style.opacity = String(Math.max(0.25, 1 - Math.abs(x) / (SWIPE_PX * 2.4)));
    };
    const settle = () => {
      swiping = false;
      if (Math.abs(dx) >= SWIPE_PX) return remove(row.id, button, Math.sign(dx));
      button.classList.add('agents-settle');
      slide(0);
      button.style.opacity = '';
      setTimeout(() => button.classList.remove('agents-settle'), 200);
      if (deferred) render();
    };
    button.addEventListener('pointerdown', event => { if (event.button === 0) { start = { x: event.clientX, y: event.clientY, id: event.pointerId }; dx = 0; } });
    button.addEventListener('pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      const x = event.clientX - start.x;
      if (!swiping) {
        if (Math.abs(x) < 8 || Math.abs(x) < Math.abs(event.clientY - start.y) * 1.5) return;
        swiping = true; clearTimeout(cardTimer); hideCard();
        try { button.setPointerCapture(event.pointerId); } catch {}
      }
      slide(x);
    });
    const release = () => {
      if (!start) return;
      start = null;
      if (swiping) { swipedAt = Date.now(); settle(); }
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    // A swipe is not a click on the row.
    button.addEventListener('click', event => { if (Date.now() - swipedAt < 500) event.stopImmediatePropagation(); }, true);
    button.addEventListener('wheel', event => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      // The trackpad keeps scrolling after a swipe; that must not take the next row too.
      if (Date.now() < wheelQuietUntil) return;
      swiping = true; clearTimeout(cardTimer); hideCard();
      slide(dx - event.deltaX);
      clearTimeout(wheelTimer);
      if (Math.abs(dx) >= SWIPE_PX) { swiping = false; remove(row.id, button, Math.sign(dx)); }
      else wheelTimer = setTimeout(settle, 160);
    }, { passive: false });
  }
  function remove(id, button, direction) {
    wheelQuietUntil = Date.now() + 1200;
    gone.add(id);
    hoverId = ''; hideCard();
    button.classList.add('agents-gone');
    button.style.transform = 'translateX(' + direction * 280 + 'px)';
    button.style.opacity = '0';
    request('/api/agents/hide', { id }).catch(() => {}).finally(async () => {
      await new Promise(resolve => setTimeout(resolve, 260));
      await refresh();
      gone.delete(id);
    });
  }
  function folded(rows) {
    const pill = element('button', 'agents-pill');
    pill.type = 'button';
    pill.title = '展开任务小窗';
    pill.setAttribute('aria-label', '展开任务小窗');
    for (const row of rows.slice(0, 8)) pill.append(dot(row));
    if (rows.length) pill.append(element('span', 'agents-pill-sep'));
    for (const tool of ['claude', 'codex', 'dsh']) {
      const count = rows.filter(row => row.tool === tool).length;
      if (count) pill.append(toolIcon({ tool }), element('span', 'agents-pill-n', String(count)));
    }
    if (!rows.length) pill.append(toolIcon({ tool: 'claude' }), toolIcon({ tool: 'codex' }));
    pill.addEventListener('click', () => { settings.folded = false; save(); render(); });
    pill.addEventListener('pointerdown', startDrag);
    return [pill];
  }
  function footer() {
    const foot = element('footer', 'agents-foot');
    for (const tool of ['claude', 'codex']) {
      const limits = data?.limits?.[tool];
      if (!limits?.available) continue;
      const five = remaining(limits.fiveHour), week = remaining(limits.sevenDay);
      const quota = element('span', 'agents-quota'), text = element('span');
      const part = (label, value) => {
        if (value === null) return [];
        const number = element('b', value < 25 ? 'low' : '', value + '%');
        return [document.createTextNode(label + ' '), number];
      };
      const pieces = [...part('5h', five), ...(five !== null && week !== null ? [document.createTextNode(' · ')] : []), ...part('7d', week)];
      if (!pieces.length) continue;
      text.append(...pieces);
      quota.title = (tool === 'claude' ? 'Claude' : 'Codex') + ' 订阅剩余';
      quota.append(toolIcon({ tool }), text);
      foot.append(quota);
    }
    return foot;
  }
  function claudeNotice() {
    const notice = element('div', 'agents-notice', 'Claude Code 要更新接入才会出现在这里');
    const update = element('button', '', '更新');
    update.type = 'button';
    update.addEventListener('click', async () => {
      const result = await request('/api/claude/integration', { action: 'install' }).catch(() => ({ ok: false }));
      toast(result.ok ? '已更新，Claude Code 会话下次发消息或回复完成时出现在这里' : result.error || '没能更新 Claude Code 接入');
      refresh();
    });
    notice.append(update);
    return notice;
  }
  const toolName = row => row.app ? 'Codex App' : TOOL_NAME[row.tool] || row.tool;

  function mark() {
    for (const node of panel?.querySelectorAll('.agents-row') || []) node.classList.toggle('agents-hover', node.dataset.id === hoverId);
  }
  function showCard(id) {
    const row = (data?.rows || []).find(item => item.id === id), anchor = panel?.querySelector('.agents-row[data-id="' + CSS.escape(id) + '"]');
    if (!row || !anchor || !card) return hideCard();
    const now = Date.now(), title = element('h4', '', row.title || row.name), meta = element('div', 'agents-meta', [toolName(row), row.place || row.cwd].filter(Boolean).join(' · '));
    const say = element('div', 'agents-say');
    say.append(dot(row), element('span', '', stateSentence(row, now)));
    const usage = element('div', 'agents-usage');
    if (Number.isFinite(row.tokens)) {
      usage.append(element('span', '', tokens(row.tokens) + ' tokens'));
      if (Number.isFinite(row.contextPercent)) {
        const bar = element('span', 'agents-bar' + (row.contextPercent >= 80 ? ' full' : '')), fill = element('i');
        fill.style.width = Math.max(2, Math.min(100, row.contextPercent)) + '%';
        bar.append(fill);
        usage.append(bar, element('span', '', '上下文 ' + Math.round(row.contextPercent) + '%'));
      }
    } else usage.append(element('span', '', '这个会话的用量还没统计到'));
    const acts = element('div', 'agents-acts'), go = element('button', 'primary');
    go.type = 'button';
    go.append(icon('jump'), document.createTextNode(row.app ? '打开 Codex' : '跳过去'));
    go.addEventListener('click', () => jump(row.id));
    acts.append(go, element('span', 'agents-hint', '左右滑动这一行可以移除'));
    card.replaceChildren(title, meta, say, usage, acts);
    card.hidden = false;
    // Beside the panel, on whichever side has room.
    const box = panel.getBoundingClientRect(), line = anchor.getBoundingClientRect();
    const left = box.left - 10 - CARD_WIDTH >= 8 ? box.left - 10 - CARD_WIDTH : Math.min(box.right + 10, innerWidth - CARD_WIDTH - 8);
    card.style.left = Math.max(8, left) + 'px';
    card.style.top = Math.max(8, Math.min(line.top - 8, innerHeight - card.offsetHeight - 8)) + 'px';
  }
  function hideCard() { if (card) card.hidden = true; }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hoverId = ''; mark(); hideCard(); }, 220);
  }

  async function jump(id) {
    if (busy) return;
    busy = true;
    try {
      const result = await request('/api/agents/jump', { id });
      if (!result.ok) toast(result.error || '没能跳过去');
      else if (result.message) toast(result.message);
    } catch { toast('没能跳过去'); }
    finally { busy = false; }
    refresh();
  }

  // Where the panel sits: its saved spot or the top right corner when pinned,
  // or beside the pet, on the side with more room, when following.
  function place() {
    if (!panel) return;
    const width = panel.offsetWidth, height = panel.offsetHeight;
    let x, y;
    if (settings.mode === 'follow') {
      const pet = document.querySelector('.dshwv-img')?.getBoundingClientRect();
      if (!pet || !pet.width) return;
      x = pet.left + pet.width / 2 > innerWidth / 2 ? pet.left - width - 8 : pet.right + 8;
      y = pet.top + 12;
    } else {
      // A spot saved by an earlier version is its left edge; keep the nearer side instead.
      if (Number.isFinite(settings.x)) {
        settings.side = settings.x + width / 2 > innerWidth / 2 ? 'right' : 'left';
        settings.edge = Math.max(4, settings.side === 'right' ? innerWidth - settings.x - width : settings.x);
        delete settings.x; save();
      }
      const edge = Number.isFinite(settings.edge) ? settings.edge : 16;
      x = settings.side === 'left' ? edge : innerWidth - width - edge;
      y = Number.isFinite(settings.y) ? settings.y : 44;
    }
    panel.style.left = Math.round(Math.max(4, Math.min(x, innerWidth - width - 4))) + 'px';
    panel.style.top = Math.round(Math.max(4, Math.min(y, innerHeight - height - 4))) + 'px';
    panel.style.right = 'auto';
  }
  function follow() {
    clearInterval(followTimer);
    if (settings.on && settings.mode === 'follow') followTimer = setInterval(place, 200);
  }
  // Dragging the header moves a pinned panel, and pins one that was following.
  function startDrag(event) {
    if (event.button !== 0 || event.target.closest('.agents-btn')) return;
    const box = panel.getBoundingClientRect(), dx = event.clientX - box.left, dy = event.clientY - box.top, start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const move = e => {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      moved = dragging = true;
      const left = e.clientX - dx, width = panel.offsetWidth;
      settings.mode = 'pin'; settings.side = left + width / 2 > innerWidth / 2 ? 'right' : 'left';
      settings.edge = settings.side === 'right' ? innerWidth - left - width : left; settings.y = e.clientY - dy;
      place(); hideCard();
    };
    const end = () => {
      dragging = false;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      if (moved) {
        save(); follow();
        // A drag of the folded strip is not a click on it.
        target.addEventListener('click', e => e.stopImmediatePropagation(), { capture: true, once: true });
        setTimeout(() => render({ force: true }));
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  async function refresh() {
    clearTimeout(timer);
    if (!settings.on) return;
    if (!document.hidden) {
      try {
        const next = await request('/api/agents');
        if (next?.ok) data = next;
      } catch {}
      render();
    }
    timer = setTimeout(refresh, POLL_MS);
  }
  function setEnabled(on) {
    settings.on = !!on; save();
    window.dispatchEvent(new CustomEvent('whale-agents', { detail: { on: settings.on } }));
    follow();
    if (settings.on) refresh(); else { clearTimeout(timer); render(); }
  }
  // A dispatched task finished or failed: a short toast, then the list catches
  // up on the next poll. Clicking the row opens the workbench/session.
  window.addEventListener('whale-work-notice', event => {
    const task = event.detail?.task;
    if (!task) return;
    const label = task.status === 'done' ? '任务完成' : task.status === 'aborted' ? '任务已停止' : task.status === 'timeout' ? '任务超时' : '任务出错';
    toast(label + '：' + String(task.prompt || '').slice(0, 40));
    if (settings.on) refresh();
  });
  // Re-placing a pinned corner keeps it on screen when the window changes size.
  window.addEventListener('resize', place);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && settings.on) refresh(); });
  window.WhaleAgents = Object.freeze({ enabled: () => settings.on, setEnabled, refresh });
  const start = () => { follow(); refresh(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
