import fs from 'node:fs';
import path from 'node:path';
import { agentRow } from './row.mjs';

// DSH keeps a small JSON projection per session under
// $DSH_HOME/storages/session_projcache/sessions. It is enough to know what a
// session is doing without reading the compressed conversation log: title,
// project, current step, token pressure and whether it is waiting for an
// answer. The task window only shows sessions that were active recently.
const MINUTE = 60000;
const MAX_FILES = 80;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function workspaceTitles(workspace) {
  const titles = new Map();
  const tables = workspace?.tables?.workspaces;
  if (!tables || typeof tables !== 'object') return titles;
  for (const item of Object.values(tables)) {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title) continue;
    for (const id of Array.isArray(item.sessionIds) ? item.sessionIds : []) if (typeof id === 'string') titles.set(id, item.title);
  }
  return titles;
}

function dshRow({ id, doc, mtime, now, stuckMs, keepDoneMs, staleMs, workspaceNames }) {
  const rows = doc?.record?.rows;
  if (!rows || typeof rows !== 'object') return null;
  const stats = rows.sessionStats?.val && typeof rows.sessionStats.val === 'object' ? rows.sessionStats.val : {};
  const boundary = rows.turnBoundary?.val && typeof rows.turnBoundary.val === 'object' ? rows.turnBoundary.val : {};
  const questions = Array.isArray(rows.userQuestions?.val?.questions?.active) ? rows.userQuestions.val.questions.active : [];
  const goal = rows.goal?.val && typeof rows.goal.val === 'object' ? rows.goal.val : {};
  const retry = rows.llmRetry?.val && typeof rows.llmRetry.val === 'object' ? rows.llmRetry.val : {};
  const pending = stats.pendingCalls && typeof stats.pendingCalls === 'object' ? Object.keys(stats.pendingCalls).length : 0;
  const lastPromptAt = timestamp(rows.timeContext?.val?.lastMessageTime);
  const lastActivity = Math.min(now, Math.max(mtime, lastPromptAt ?? 0));
  const openStep = stats.openStep && typeof stats.openStep === 'object' ? stats.openStep : null;
  const running = !!openStep || boundary.openTurnStartSeq != null || pending > 0;

  let state, since, reason = '';
  if (questions.length) {
    state = 'question';
    since = timestamp(questions[0]?.askedAt) ?? lastActivity;
    reason = '等你回答';
  } else if (goal.failure) {
    state = 'failed';
    since = lastActivity;
    reason = '目标失败';
  } else if (running) {
    state = now - lastActivity >= stuckMs ? 'stuck' : 'running';
    since = timestamp(openStep?.startTime) ?? lastActivity;
    reason = pending ? '工具运行中' : '进行中';
  } else if ((Number(stats.lastTurn) || 0) > 0 && boundary.lastStepBoundary?.kind === 'end') {
    state = now - lastActivity >= keepDoneMs ? 'idle' : 'done';
    since = lastActivity;
    reason = '已完成';
  } else if (Object.keys(retry).length) {
    state = 'failed';
    since = lastActivity;
    reason = '模型重试';
  } else {
    state = 'idle';
    since = lastActivity;
    reason = '空闲';
  }
  if (now - lastActivity >= staleMs) return null;

  const turns = Array.isArray(rows.turnOutline?.val?.turns) ? rows.turnOutline.val.turns : [];
  const lastTurn = turns.at(-1) || null;
  const title = text(rows.title?.val, 120) || text(lastTurn?.prompt, 80);
  const lastTurnCount = Number(stats.lastTurn) || 0;
  if (!title && !lastTurnCount && !questions.length && !running) return null;

  const cwd = typeof rows.workingDirectory?.val === 'string' ? rows.workingDirectory.val :
    typeof doc.record?.identity?.cwd === 'string' ? doc.record.identity.cwd : '';
  const tokens = finite(rows.contextPressure?.val?.surfaceTokens);
  const contextWindow = finite(rows.contextPressure?.val?.contextWindow);
  const step = finite(openStep?.step) ?? (Number(stats.steps) > 0 ? Number(stats.steps) : null);
  const steps = Number(stats.steps) > 0 ? Number(stats.steps) : null;
  const latest = text(lastTurn?.response, 4000);
  const prompt = text(lastTurn?.prompt, 2000);

  return agentRow({
    id: 'dsh:' + id, key: state + ':' + since, tool: 'dsh', app: false, sessionId: id, source: 'observed',
    cwd, title, prompt, latest, state, since, activeAt: lastActivity, reason, step, steps,
    tokens, contextWindow, workspace: workspaceNames.get(id) || '',
  });
}

// Reads the projection cache once. A corrupt or half-written file is skipped;
// it must never take down the Codex/Claude rows. Returns rows plus a
// user-facing error when some records could not be read.
export function readDshSessions({ dshHome = null, now = Date.now(), stuckMs = 15 * MINUTE, keepDoneMs = 30 * MINUTE, staleMs = 120 * MINUTE } = {}) {
  if (!dshHome) return { rows: [], error: '' };
  const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  let names;
  try { names = fs.readdirSync(cacheDir).filter(name => name.endsWith('.json')); }
  catch (error) {
    // No DSH installation or no session has been projected yet: that is an
    // empty list, not a broken integration.
    if (error?.code === 'ENOENT') return { rows: [], error: '' };
    return { rows: [], error: 'DSH 任务记录暂不可读' };
  }

  const workspace = readJson(path.join(dshHome, 'storages', 'workspace.json'), {});
  const archived = new Set(Array.isArray(workspace?.global?.archivedSessionIds) ? workspace.global.archivedSessionIds : []);
  const workspaceNames = workspaceTitles(workspace);
  const files = [];
  for (const name of names) {
    const file = path.join(cacheDir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (now - stat.mtimeMs >= staleMs) continue;
    files.push({ name, file, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const rows = [];
  let error = '';
  for (const item of files.slice(0, MAX_FILES)) {
    const id = item.name.slice(0, -'.json'.length);
    if (archived.has(id)) continue;
    const doc = readJson(item.file, null);
    if (!doc || typeof doc !== 'object') { error ||= '部分 DSH 任务记录不可读'; continue; }
    if (doc.version !== 7) { error ||= 'DSH 任务缓存版本不兼容'; continue; }
    const row = dshRow({ id, doc, mtime: item.mtime, now, stuckMs, keepDoneMs, staleMs, workspaceNames });
    if (row) rows.push(row);
  }
  return { rows, error };
}
