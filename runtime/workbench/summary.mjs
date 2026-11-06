import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { readJson, writeJson } from '../paths.mjs';
import { readCodexDigest } from './codex-digest.mjs';
import { readDshDigest } from './dsh-digest.mjs';
import { SUMMARY_INSTRUCTION, REPORT_INSTRUCTION, buildTaskSummaryPrompt, buildDailyReportPrompt } from './summary-prompt.mjs';

const SUMMARY_VERSION = 2;
const SUMMARY_MAX = 200;
const MAX_SUMMARIES = 200;
const MAX_REPORTS = 60;

function clip(value, max) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''; }
function dayKey(ts) {
  const date = new Date(ts);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function duration(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  return minutes < 60 ? minutes + ' 分钟' : Math.floor(minutes / 60) + ' 小时' + (minutes % 60 ? ' ' + minutes % 60 + ' 分钟' : '');
}
function projectOf(cwd) { return path.basename(cwd || '') || '未知项目'; }
function plainText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(^|\s)[-*+]\s+/g, '$1')
    .replace(/(^|\s)\d+[.)]\s+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_~|]/g, ' ')
    .replace(/…/g, ' ')
    .replace(/\.{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function limitSummary(value) {
  const text = plainText(value);
  if (!text) return '没有可读取的回答。';
  if (text.length <= SUMMARY_MAX) return text;
  const head = text.slice(0, SUMMARY_MAX);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'), head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf(';'));
  return (cut >= SUMMARY_MAX * 0.6 ? head.slice(0, cut + 1) : head).trim();
}

function deterministic(digest) {
  return limitSummary(digest.latest || digest.error || '');
}

export class SummaryService {
  constructor({ dataDir, codexHome = path.join(os.homedir(), '.codex'), dshHome = path.join(os.homedir(), '.dsh'), agents = null, runner = null, settings, chat = () => null, now = () => Date.now() }) {
    this.dataDir = dataDir;
    this.codexHome = codexHome;
    this.dshHome = dshHome;
    this.agents = agents;
    this.runner = runner;
    this.settings = settings;
    this.chat = chat;
    this.now = now;
    this.file = path.join(dataDir, 'work-summaries.json');
    this.reportFile = path.join(dataDir, 'work-reports.json');
    this.summaries = {};
    this.reports = {};
    try { const stored = readJson(this.file, null); if (stored && typeof stored.summaries === 'object') this.summaries = stored.summaries; } catch {}
    try { const stored = readJson(this.reportFile, null); if (stored && typeof stored.reports === 'object') this.reports = stored.reports; } catch {}
  }

  readContent() { return this.settings?.public?.().readTaskContent !== false; }

  saveSummaries() {
    const entries = Object.entries(this.summaries).sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0)).slice(0, MAX_SUMMARIES);
    this.summaries = Object.fromEntries(entries);
    try { writeJson(this.file, { version: 1, summaries: this.summaries }); } catch {}
  }

  saveReports() {
    const entries = Object.entries(this.reports).sort((a, b) => String(b[0]).localeCompare(String(a[0]))).slice(0, MAX_REPORTS);
    this.reports = Object.fromEntries(entries);
    try { writeJson(this.reportFile, { version: 1, reports: this.reports }); } catch {}
  }

  cached(key) { return this.summaries[key] || null; }

  record(key, text, sourceVersion, meta = {}) {
    this.summaries[key] = { text, sourceVersion, createdAt: this.now(), version: SUMMARY_VERSION, tool: meta.tool || '', project: meta.project || '', state: meta.state || '' };
    this.saveSummaries();
  }

  runnerDigest(task) {
    const content = this.readContent();
    return {
      tool: task.tool === 'dsh' ? 'DSH' : 'Codex', cwd: task.cwd || '', project: projectOf(task.cwd),
      state: task.status, duration: duration(task.startedAt, task.finishedAt || task.updatedAt),
      tokens: task.tokens || null, prompt: content ? clip(task.prompt, 2000) : '',
      latest: content ? clip(task.finalText || task.latestText || task.lastEvent, 4000) : '',
      error: task.error || '', key: 'task:' + task.id,
      sourceVersion: 'runner:' + task.status + ':' + (task.updatedAt || task.startedAt || task.createdAt) + ':content:' + content,
    };
  }

  codexDigest(row) {
    const content = this.readContent();
    const sessionId = row.sessionId || String(row.id || '').replace(/^codex:/, '');
    const stored = content ? readCodexDigest({ codexHome: this.codexHome, sessionId, readContent: true }) : null;
    return {
      tool: 'Codex', cwd: row.cwd || stored?.cwd || '', project: projectOf(row.cwd || stored?.cwd),
      state: row.state, duration: '', tokens: row.tokens || null,
      prompt: content ? clip(row.prompt || stored?.prompt, 2000) : '',
      latest: content ? clip(row.latest || stored?.lastAgent, 4000) : '',
      error: row.error || '', key: 'codex:' + (sessionId || row.id),
      sourceVersion: 'codex:' + sessionId + ':' + (stored?.size || '') + ':' + (stored?.mtime || row.activeAt || '') + ':content:' + content,
    };
  }

  rowDigest(row) {
    const content = this.readContent();
    const stored = content && row.tool === 'dsh' && row.sessionId
      ? readDshDigest({ dshHome: this.dshHome, sessionId: row.sessionId, readContent: true }) : null;
    return {
      tool: row.tool === 'dsh' ? 'DSH' : row.tool === 'claude' ? 'Claude Code' : 'Codex',
      cwd: row.cwd || '', project: projectOf(row.cwd), state: row.state,
      duration: duration(row.since, this.now()), tokens: row.tokens || null,
      prompt: content ? clip(stored?.prompt || row.prompt, 2000) : '',
      latest: content ? clip(stored?.lastAgent || row.latest, 4000) : '',
      error: row.error || '', key: (row.tool || 'task') + ':' + (row.sessionId || row.id),
      sourceVersion: (row.tool || 'task') + ':' + (row.sessionId || row.id) + ':' + (row.activeAt || row.since || '') + ':' + row.state + ':content:' + content + ':' + (stored?.size || ''),
    };
  }

  resolve(id) {
    const task = this.runner?.find?.(id);
    if (task && task.status !== 'draft') return { kind: 'runner', task, digest: this.runnerDigest(task) };
    const row = this.agents?.find?.(id);
    if (!row) return null;
    if (row.tool === 'codex') return { kind: 'row', row, digest: this.codexDigest(row) };
    return { kind: 'row', row, digest: this.rowDigest(row) };
  }

  async model(instruction, prompt, maxTokens) {
    const chat = this.chat();
    if (!chat || typeof chat.generateText !== 'function') return null;
    try {
      const result = await chat.generateText({ instruction, prompt, maxTokens, timeoutMs: 30000 });
      return result?.ok ? result.text : null;
    } catch { return null; }
  }

  async task(id, { refresh = false } = {}) {
    const resolved = this.resolve(id);
    if (!resolved) return { ok: false, error: '找不到这个任务' };
    const digest = resolved.digest;
    const source = { prompt: digest.prompt, latest: digest.latest, error: digest.error };
    const cached = this.cached(digest.key);
    const cachedText = typeof cached?.text === 'string' ? cached.text.trim() : '';
    const cleanCached = cachedText && plainText(cachedText) === cachedText && cachedText.length <= SUMMARY_MAX && !/(?:…|\.\.\.)$/.test(cachedText);
    if (!refresh && cached && cached.version === SUMMARY_VERSION && cleanCached && cached.sourceVersion === digest.sourceVersion) {
      return { ok: true, id: digest.key, text: cached.text, cached: true, createdAt: cached.createdAt, source };
    }
    const generated = await this.model(SUMMARY_INSTRUCTION, buildTaskSummaryPrompt(digest), 300);
    const text = limitSummary(generated || deterministic(digest));
    this.record(digest.key, text, digest.sourceVersion, digest);
    return { ok: true, id: digest.key, text, cached: false, fallback: !generated, createdAt: this.now(), source };
  }

  async report({ day = dayKey(this.now()), refresh = false } = {}) {
    const tasks = [], seen = new Set(), included = new Set();
    const runnerSnapshot = this.runner?.snapshot?.() || { tasks: [] };
    for (const task of runnerSnapshot.tasks || []) {
      if (task.status === 'draft') continue;
      const stamp = task.finishedAt || task.updatedAt || task.createdAt;
      if (dayKey(stamp) !== day) continue;
      const digest = this.runnerDigest(task);
      const cached = this.cached(digest.key);
      tasks.push({ ...digest, summary: cached?.text || deterministic(digest) });
      included.add(digest.key);
      if (task.sessionId) seen.add(task.sessionId);
    }
    for (const row of this.agents?.rows?.() || []) {
      if (row.sessionId && seen.has(row.sessionId)) continue;
      if (dayKey(row.activeAt || row.since) !== day) continue;
      const digest = row.tool === 'codex' ? this.codexDigest(row) : this.rowDigest(row);
      const cached = this.cached(digest.key);
      tasks.push({ ...digest, summary: cached?.text || deterministic(digest) });
      included.add(digest.key);
    }
    // Tasks that already scrolled out of the task window still count if the
    // user summarized them today.
    for (const [key, item] of Object.entries(this.summaries)) {
      if (included.has(key) || dayKey(item.createdAt) !== day || !item.text) continue;
      tasks.push({ tool: item.tool || '任务', project: item.project || '', state: item.state || '', summary: item.text, sourceVersion: item.sourceVersion || key, key });
      included.add(key);
    }
    tasks.sort((a, b) => (b.sourceVersion > a.sourceVersion ? 1 : -1));
    if (!tasks.length) return { ok: true, day, text: '今天还没有记录到任务。', cached: false, tasks: 0 };
    const sourceHash = tasks.map(item => item.sourceVersion).join('|');
    const existing = this.reports[day];
    if (!refresh && existing && existing.sourceHash === sourceHash) {
      return { ok: true, day, text: existing.text, cached: true, tasks: tasks.length, createdAt: existing.createdAt };
    }
    const generated = await this.model(REPORT_INSTRUCTION, buildDailyReportPrompt(day, tasks.slice(0, 20)), 700);
    const text = generated || ['今天记录了 ' + tasks.length + ' 个任务。', ...tasks.slice(0, 8).map(item => '· ' + item.tool + '：' + item.summary)].join('\n');
    this.reports[day] = { text, sourceHash, createdAt: this.now() };
    this.saveReports();
    return { ok: true, day, text, cached: false, fallback: !generated, tasks: tasks.length, createdAt: this.now() };
  }
}
