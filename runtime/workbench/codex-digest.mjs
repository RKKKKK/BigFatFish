import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A small, bounded reader for a finished or running Codex session. It never
// stores the conversation; it extracts only the last prompt and last answer for
// a summary. Files can be tens of megabytes, so only the header and a 2 MiB
// tail are read.
function tailLines(file, bytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(stat.size - start);
  try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return { lines: lines.filter(Boolean), size: stat.size, mtime: stat.mtimeMs };
}

function header(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
  try { fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
  const end = buffer.indexOf(10);
  if (end < 0) return null;
  try { return JSON.parse(buffer.subarray(0, end).toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function cleanUser(text) {
  if (!text) return '';
  if (text.startsWith('<environment_context>')) return '';
  if (text.includes('<permissions instructions>')) return '';
  if (text.startsWith('The following is the Codex agent history')) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function clip(value, max) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''; }

function sessions(codexHome) {
  const root = path.join(codexHome, 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { const stat = fs.statSync(file); files.push({ file, mtime: stat.mtimeMs }); } catch {}
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

function titles(codexHome) {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (typeof row.id === 'string' && typeof row.thread_name === 'string') map.set(row.id, row.thread_name);
    }
  } catch {}
  return map;
}

// Returns null when the file or session id cannot be found; a small digest
// otherwise. `readContent:false` reads only the file header and size.
export function readCodexDigest({ codexHome = path.join(os.homedir(), '.codex'), sessionId, readContent = true } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const file = sessions(codexHome).find(item => path.basename(item.file).includes(sessionId));
  if (!file) return null;
  const meta = header(file.file)?.payload || {};
  const index = titles(codexHome);
  const result = {
    title: index.get(sessionId) || '',
    cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
    originator: typeof meta.originator === 'string' ? meta.originator : '',
    subagent: meta.thread_source === 'subagent' || !!meta.source?.subagent,
    size: 0, mtime: file.mtime, prompt: '', lastAgent: '', outcome: '',
  };
  if (!readContent) return result;
  const tail = tailLines(file.file, 2 * 1024 * 1024);
  result.size = tail.size; result.mtime = tail.mtime;
  for (const line of tail.lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload || {};
    if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = (payload.content || []).filter(part => part.type === 'input_text').map(part => part.text).join('\n');
      const clean = cleanUser(text);
      if (clean) result.prompt = clip(clean, 2000);
    }
    if (event.type === 'event_msg' && payload.type === 'task_complete') {
      result.lastAgent = clip(payload.last_agent_message, 4000);
      result.outcome = payload.error ? 'failed' : 'completed';
    }
    if (event.type === 'event_msg' && /aborted$/.test(String(payload.type))) result.outcome = 'aborted';
  }
  return result;
}
