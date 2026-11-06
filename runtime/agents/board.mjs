import { readClaudeSessions } from './claude-hooks.mjs';
import { readDshSessions } from './dsh.mjs';
import { agentRow } from './row.mjs';

// The task window's list: one row per open Claude Code or Codex session.
//   green  running (breathing) or done
//   yellow a question or a permission request: waiting for the user
//   red    stuck (no progress for a while), failed or interrupted
//   gray   idle: open, with nothing new for a while
const MINUTE = 60000;
const RANK = { red: 0, yellow: 1, green: 2, gray: 3 };
// Events logged this soon after a request may belong to the step that asked;
// only later ones show the user has answered.
const ANSWER_GRACE = 2000;

export class AgentBoard {
  constructor({ dataDir, dshHome = null, dshPollMs = 1000, extraRows = () => [], suppressedSessions = () => new Set(), now = () => Date.now(), stuckMs = 15 * MINUTE, keepDoneMs = 30 * MINUTE, staleMs = 120 * MINUTE } = {}) {
    Object.assign(this, { dataDir, dshHome, dshPollMs, extraRows, suppressedSessions, now, stuckMs, keepDoneMs, staleMs });
    this.codex = new Map(); this.approvals = new Map(); this.hidden = new Map();
    this.dshCache = { at: 0, rows: [], error: '' };
  }

  // DSH's projection cache is read at most once a second, so the task window's
  // poll does not parse every session file twice.
  dshRows(now = this.now()) {
    if (!this.dshHome) return { rows: [], error: '' };
    if (now - this.dshCache.at < this.dshPollMs) return this.dshCache;
    const result = readDshSessions({ dshHome: this.dshHome, now, stuckMs: this.stuckMs, keepDoneMs: this.keepDoneMs, staleMs: this.staleMs });
    this.dshCache = { at: now, rows: result.rows, error: result.error };
    return this.dshCache;
  }

  dshStatus() {
    const cache = this.dshRows(this.now());
    return { enabled: !!this.dshHome, count: cache.rows.length, error: cache.error };
  }

  // The latest view of one Codex session, from its log.
  codexSession(view) {
    if (!view || typeof view.sessionId !== 'string' || !view.sessionId) return;
    this.codex.set(view.sessionId, view);
    if (this.codex.size > 256) {
      const oldest = [...this.codex.values()].sort((a, b) => a.activeAt - b.activeAt).slice(0, this.codex.size - 256);
      for (const item of oldest) this.codex.delete(item.sessionId);
    }
  }

  // Codex asks for approval. Its hook names the session, or at least the
  // folder; a subagent's request is its parent's. A request that names
  // neither can only be the one running session's.
  codexApproval({ sessionId = '', cwd = '' } = {}, at = this.now()) {
    let view = this.codex.get(sessionId);
    if (view?.isSubagent && view.parentThreadId) view = this.codex.get(view.parentThreadId) || view;
    if (!view) {
      const running = [...this.codex.values()].filter(item => !item.isSubagent && item.state === 'running' && (!cwd || item.cwd === cwd));
      if (cwd || running.length === 1) view = running.sort((a, b) => b.activeAt - a.activeAt)[0];
    }
    const id = view?.sessionId || sessionId;
    if (!id) return false;
    this.approvals.set(id, at);
    return true;
  }

  // Every open session, most urgent first: red, yellow, running, done, idle.
  // A Claude session leaves when it ends; Codex never says so, so its rows
  // leave after two hours without a word.
  rows() {
    const now = this.now(), rows = [];
    let suppressed = new Set(), extra = [];
    try { suppressed = this.suppressedSessions() || new Set(); } catch {}
    try { extra = this.extraRows() || []; } catch {}
    for (const view of this.codex.values()) {
      if (view.isSubagent || suppressed.has(view.sessionId) || !view.state || now - Math.max(view.since, view.activeAt) >= this.staleMs) continue;
      rows.push(this.codexRow(view, now));
    }
    for (const session of readClaudeSessions(this.dataDir, now)) {
      const row = this.claudeRow(session, now);
      if (row) rows.push(row);
    }
    for (const row of this.dshRows(now).rows) if (!suppressed.has(row.sessionId)) rows.push(row);
    for (const row of extra) rows.push(row);
    const shown = rows.filter(row => this.hidden.get(row.id) !== row.key);
    // The longest wait first among alerts, the newest first among the rest.
    const alert = row => row.color === 'red' || row.color === 'yellow';
    return shown.sort((a, b) => RANK[a.color] - RANK[b.color] || (alert(a) ? a.since - b.since : (a.state === 'done') - (b.state === 'done') || b.since - a.since));
  }

  find(id) {
    const now = this.now();
    try { const extra = this.extraRows().find(row => row.id === id); if (extra) return extra; } catch {}
    const view = this.codex.get(String(id).replace(/^codex:/, ''));
    if (String(id).startsWith('codex:') && view) return this.codexRow(view, now);
    const session = String(id).startsWith('claude:') && readClaudeSessions(this.dataDir, now).find(item => 'claude:' + item.sessionId === id);
    if (session) return this.claudeRow(session, now);
    if (String(id).startsWith('dsh:')) return this.dshRows(now).rows.find(item => item.id === id) || null;
    return null;
  }

  // Leaves a row out until its session does something new: the user swiped
  // it away. A row's key changes only with what its session reports, not
  // with time, so a hidden row stays hidden as it goes stuck or idle.
  hide(id) {
    const row = this.find(id);
    if (!row) return false;
    this.hidden.set(row.id, row.key);
    for (const key of [...this.hidden.keys()].slice(0, Math.max(0, this.hidden.size - 256))) this.hidden.delete(key);
    return true;
  }

  codexRow(view, now) {
    let state = view.state, since = view.since, key = view.state + ':' + view.since;
    const asked = this.approvals.get(view.sessionId);
    if (asked !== undefined) {
      if (state === 'running' && asked >= since && view.eventAt <= asked + ANSWER_GRACE) { state = 'permission'; since = asked; key += ':asked:' + asked; }
      else this.approvals.delete(view.sessionId);
    }
    if (state === 'running' && now - view.activeAt >= this.stuckMs) { state = 'stuck'; since = view.activeAt; }
    if (state === 'done' && now - since >= this.keepDoneMs) state = 'idle';
    return agentRow({ id: 'codex:' + view.sessionId, key, tool: 'codex', app: !!view.app, cwd: view.cwd, state, since, activeAt: view.activeAt,
      tokens: view.tokens, contextWindow: view.contextWindow });
  }

  claudeRow({ sessionId, state: hook, usage }, now) {
    if (!hook && !usage) return null;
    const fields = { id: 'claude:' + sessionId, tool: 'claude', app: false, cwd: hook?.cwd || usage?.cwd || '',
      tokens: usage?.tokens ?? null, contextWindow: usage?.contextWindow ?? null, contextPercent: usage?.contextPercent ?? null };
    // Open but not doing anything: just started, or heard of only through
    // its status line, before any of the pet's hooks ran in it.
    if (!hook || hook.state === 'idle') {
      const since = hook?.since ?? usage.changedAt ?? usage.at;
      return agentRow({ ...fields, key: hook ? 'idle:' + hook.since : 'usage', state: 'idle', since, activeAt: Math.max(since, usage?.changedAt ?? 0) });
    }
    let state = hook.state, since = hook.since, key = hook.state + ':' + hook.since;
    const progress = usage?.changedAt ?? 0, activeAt = Math.max(since, progress);
    // A question or permission the user has answered shows as tokens moving again.
    if ((state === 'question' || state === 'permission') && progress > since + ANSWER_GRACE) { state = 'running'; since = hook.startedAt ?? since; key += ':answered'; }
    if (state === 'running' && now - activeAt >= this.stuckMs) { state = 'stuck'; since = activeAt; }
    if (state === 'done' && now - since >= this.keepDoneMs) state = 'idle';
    return agentRow({ ...fields, key, state, since, activeAt });
  }
}


