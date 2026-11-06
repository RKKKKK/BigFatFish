import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../paths.mjs';
import { saveClaudeTurn } from '../claude-usage.mjs';

// What a Claude Code session is doing, as its hooks and status line report it.
// Each session keeps two small files in the agents folder: the hooks write the
// state and the status line writes the usage, so neither overwrites the other.
// Only the session, its folder and token counts are kept: never prompts,
// replies, tool input or notification text.
export const AGENT_DIR = 'agents';
export const CLAUDE_TRACKED_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd']);
const NOTICE_STATES = { permission_prompt: 'permission', agent_needs_input: 'question', elicitation_dialog: 'question', elicitation_url_dialog: 'question' };

const fileId = id => /^[A-Za-z0-9_-]{1,96}$/.test(id) ? id : crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
const text = (value, max) => typeof value === 'string' && value ? value.slice(0, max) : '';
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const read = file => { try { return readJson(file, null); } catch { return null; } };

export function claudeFiles(dataDir, sessionId) {
  const base = path.join(dataDir, AGENT_DIR, 'claude-' + fileId(sessionId));
  return { state: base + '.state.json', usage: base + '.usage.json' };
}

// The state a hook event puts the session in, or null when it says nothing new.
function stateOf(input) {
  const event = input.hook_event_name;
  if (event === 'UserPromptSubmit') return 'running';
  if (event === 'Stop') return 'done';
  if (event === 'StopFailure') return 'failed';
  if (event === 'PermissionRequest') return 'permission';
  if (event === 'Notification') return NOTICE_STATES[input.notification_type] || null;
  if (event === 'SessionStart') return 'idle';
  return null;
}

// One hook call. A subagent's events belong to its parent and are left out.
export function recordClaudeHook(dataDir, input, now = Date.now()) {
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || !input.session_id || input.agent_id) return false;
  if (input.hook_event_name === 'Stop') saveClaudeTurn(dataDir, input, now);
  const files = claudeFiles(dataDir, input.session_id);
  if (input.hook_event_name === 'SessionEnd') {
    for (const file of Object.values(files)) fs.rmSync(file, { force: true });
    return true;
  }
  const state = stateOf(input);
  if (!state) return false;
  const previous = read(files.state);
  // A session that starts again after a compaction or a resume keeps what it was doing.
  if (state === 'idle' && previous) return false;
  writeJson(files.state, { tool: 'claude', sessionId: input.session_id.slice(0, 200), cwd: text(input.cwd, 4096) || previous?.cwd || '',
    state, since: now, startedAt: state === 'running' ? now : previous?.startedAt ?? null });
  return true;
}

// One status line refresh: the tokens the conversation holds now, as of the
// last request. A change in them is the session making progress.
export function recordClaudeStatus(dataDir, input, now = Date.now()) {
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || !input.session_id || input.agent_id) return false;
  const files = claudeFiles(dataDir, input.session_id), previous = read(files.usage);
  const window = input.context_window && typeof input.context_window === 'object' ? input.context_window : {};
  const size = count(window.context_window_size), percent = count(window.used_percentage), last = window.current_usage;
  const parts = last && typeof last === 'object' ? ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].map(key => count(last[key])) : [];
  const tokens = parts.some(value => value !== null) ? parts.reduce((sum, value) => sum + (value || 0), 0)
    : size && percent !== null ? Math.round(size * percent / 100) : null;
  writeJson(files.usage, { tool: 'claude', sessionId: input.session_id.slice(0, 200),
    cwd: text(input.cwd, 4096) || text(input.workspace?.current_dir, 4096) || previous?.cwd || '',
    tokens, contextPercent: percent, contextWindow: size, at: now,
    changedAt: tokens !== null && tokens !== previous?.tokens ? now : previous?.changedAt ?? null });
  return true;
}

// Every Claude session on file, its state and usage together. Files of
// sessions not heard from in a day are removed.
export function readClaudeSessions(dataDir, now = Date.now()) {
  const dir = path.join(dataDir, AGENT_DIR), sessions = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const name of names) {
    const match = name.match(/^claude-(.+)\.(state|usage)\.json$/);
    if (!match) continue;
    const file = path.join(dir, name), record = read(file);
    const at = match[2] === 'usage' ? record?.at : record?.since;
    if (!record || typeof record.sessionId !== 'string' || !Number.isFinite(at) || now - at > 86400000) {
      try { fs.rmSync(file, { force: true }); } catch {}
      continue;
    }
    const entry = sessions.get(record.sessionId) || { sessionId: record.sessionId };
    entry[match[2]] = record;
    sessions.set(record.sessionId, entry);
  }
  return [...sessions.values()];
}
