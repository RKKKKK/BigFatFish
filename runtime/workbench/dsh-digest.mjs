import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The DSH projection cache only stores a short preview of the last response.
// The full text lives in the session's zstd-compressed v4 JSONL transcript.
// Read it only when a summary is requested (readContent enabled) and return
// just the last user prompt and last assistant text.
const MAX_FILE = 64 * 1024 * 1024;
const MAX_BUFFER = 192 * 1024 * 1024;

function clip(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function findZstd() {
  const candidates = [
    process.env.ZSTD_BIN,
    'C:\\msys64\\ucrt64\\bin\\zstd.exe',
    'C:\\msys64\\usr\\bin\\zstd.exe',
    '/usr/bin/zstd',
    '/opt/homebrew/bin/zstd',
  ].filter(Boolean);
  for (const file of candidates) { try { if (fs.existsSync(file)) return file; } catch {} }
  try {
    const probe = spawnSync('zstd', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    if (!probe.error && probe.status === 0) return 'zstd';
  } catch {}
  return '';
}

function findTranscript(dshHome, sessionId) {
  const root = path.join(dshHome, 'sessions');
  const wanted = sessionId.startsWith('session-') ? sessionId : 'session-' + sessionId;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd' && file.includes(wanted)) {
        try { const stat = fs.statSync(file); found.push({ file, size: stat.size, mtime: stat.mtimeMs }); } catch {}
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0] || null;
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

export function readDshDigest({ dshHome = path.join(os.homedir(), '.dsh'), sessionId, readContent = true } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const transcript = findTranscript(dshHome, sessionId);
  if (!transcript) return null;
  const result = { size: transcript.size, mtime: transcript.mtime, prompt: '', lastAgent: '' };
  if (!readContent || transcript.size > MAX_FILE) return result;
  const zstd = findZstd();
  if (!zstd) return result;
  let output;
  try {
    const run = spawnSync(zstd, ['-d', '-c', '--', transcript.file], {
      maxBuffer: MAX_BUFFER, windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (run.error || run.status !== 0 || !Buffer.isBuffer(run.stdout)) return result;
    output = run.stdout.toString('utf8');
  } catch { return result; }

  let lastAssistant = '', lastUser = '';
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event.data?.message;
    if (!message) continue;
    if (event.type === 'assistant/message') {
      const text = messageText(message);
      if (text) lastAssistant = text;
    } else if (event.type === 'user/message') {
      const text = messageText(message);
      if (text && !text.startsWith('<environment_context>')) lastUser = text;
    }
  }
  result.prompt = clip(lastUser, 4000);
  result.lastAgent = clip(lastAssistant, 4000);
  return result;
}
