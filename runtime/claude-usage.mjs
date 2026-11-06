import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './paths.mjs';
import { WINDOW_MINUTES, publicWindows, storedWindow } from './quota/windows.mjs';

const FILE = 'claude-subscription.json';
const TURN_FILE = 'claude-last-turn.json';
// Claude's status line reports each window as a used share and a reset time in
// seconds. A window that has already reset carries nothing worth keeping.
function claudeWindow(value, windowMinutes, now) {
  const resetSeconds = value?.resets_at;
  if (!Number.isSafeInteger(resetSeconds)) return null;
  const window = storedWindow({ usedPercent: value.used_percentage, resetsAt: resetSeconds * 1000 }, windowMinutes);
  return window && window.resetsAt > now ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt } : null;
}

export function captureClaudeUsage(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const limits = input.rate_limits;
  return { source: 'claude-statusline', observedAt: now,
    fiveHour: claudeWindow(limits?.five_hour, WINDOW_MINUTES.fiveHour, now), sevenDay: claudeWindow(limits?.seven_day, WINDOW_MINUTES.sevenDay, now) };
}

// The stored snapshot, or null when there is none or it cannot be trusted.
export function readClaudeSnapshot(dataDir, now = Date.now()) {
  let snapshot;
  try { snapshot = readJson(path.join(dataDir, FILE), null); } catch { return null; }
  return snapshot?.source === 'claude-statusline' && Number.isFinite(snapshot.observedAt) && snapshot.observedAt <= now + 60000 ? snapshot : null;
}

// A push without quota, such as one made before the first reply, keeps the
// windows already known instead of replacing them with nothing.
export function saveClaudeUsage(dataDir, input, now = Date.now()) {
  const snapshot = captureClaudeUsage(input, now);
  if (!snapshot || !snapshot.fiveHour && !snapshot.sevenDay) return false;
  const previous = readClaudeSnapshot(dataDir, now);
  for (const [key, minutes] of Object.entries(WINDOW_MINUTES)) {
    const kept = storedWindow(previous?.[key], minutes);
    if (!snapshot[key] && kept && kept.resetsAt > now) snapshot[key] = { usedPercent: kept.usedPercent, resetsAt: kept.resetsAt };
  }
  writeJson(path.join(dataDir, FILE), snapshot);
  return true;
}

export function claudeSubscription(dataDir, now = Date.now()) {
  const snapshot = readClaudeSnapshot(dataDir, now);
  if (!snapshot) return { ok: true, available: false, source: 'claude-statusline' };
  const windows = publicWindows(snapshot, now);
  return { ok: true, available: windows.available, source: 'claude-statusline', provider: 'Claude',
    observedAt: new Date(snapshot.observedAt).toISOString(), fiveHour: windows.fiveHour, sevenDay: windows.sevenDay };
}

export function saveClaudeTurn(dataDir, input, now = Date.now()) {
  if (!input || input.hook_event_name !== 'Stop' || typeof input.session_id !== 'string' || !input.session_id ||
    !Number.isFinite(now) || now <= 0) return false;
  writeJson(path.join(dataDir, TURN_FILE), { source: 'claude-stop', id: randomUUID(), completedAt: now });
  return true;
}

export function claudeLastTurn(dataDir, now = Date.now()) {
  let turn;
  try { turn = readJson(path.join(dataDir, TURN_FILE), null); } catch { turn = null; }
  if (!turn || turn.source !== 'claude-stop' || typeof turn.id !== 'string' || !Number.isFinite(turn.completedAt) ||
    turn.completedAt > now + 60000) return { ok: true, available: false, provider: 'Claude' };
  return { ok: true, available: true, provider: 'Claude', id: turn.id, completedAt: turn.completedAt,
    subscription: claudeSubscription(dataDir, now) };
}
