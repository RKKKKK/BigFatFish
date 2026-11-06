import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../paths.mjs';

// What the character is allowed to remember across conversations: a small,
// hand-editable profile kept in the pet's data directory. The model never sees
// raw conversation history here; it sees this rendered block plus the current
// conversation. Every write is capped so it cannot grow into a second history.
export const SECTIONS = Object.freeze({
  identity: '称呼',
  preferences: '偏好',
  longTerm: '长期要求',
  projects: '项目',
  decisions: '决定',
  episodes: '近期',
});
const LIMITS = Object.freeze({ identity: 3, preferences: 8, longTerm: 10, projects: 8, decisions: 8, episodes: 8 });
const MAX_ITEMS = 40;
const MAX_TEXT = 160;
const MAX_BLOCK_BYTES = 4096;
const MAX_BLOCKED = 10;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const SECRET = /(?:sk-[a-z0-9]{16,}|api[\s_-]?key|密钥|密码|token\s*[:=]|bearer\s+\S+|eyJ[a-z0-9_-]{10,}\.)/i;

function textOf(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
function normalized(value) {
  return value.replace(/[\s\p{P}]/gu, '').toLowerCase();
}
function timestamp(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}
function itemId() {
  return 'm-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 6);
}
function makeItem(section, text, now, source, pinned = false) {
  if (!Object.hasOwn(SECTIONS, section)) throw new Error('未知的记忆分组');
  if (CONTROL.test(text)) throw new Error('记忆内容包含无效字符');
  if (SECRET.test(text)) throw new Error('不要保存密钥、密码或令牌');
  const clean = textOf(text);
  if (!clean) throw new Error('记忆内容不能为空');
  const createdAt = new Date(now).toISOString();
  return { id: itemId(), section, text: clean, pinned: !!pinned, source, createdAt, updatedAt: createdAt };
}

function normalize(raw, now) {
  const items = [];
  const blocked = [];
  if (Array.isArray(raw?.blocked)) {
    for (const value of raw.blocked.slice(0, MAX_BLOCKED)) {
      const clean = textOf(value);
      if (clean && !SECRET.test(clean)) blocked.push(clean);
    }
  }
  if (Array.isArray(raw?.items)) {
    for (const value of raw.items) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(SECTIONS, value.section)) continue;
      const text = textOf(value.text);
      if (!text || CONTROL.test(text) || SECRET.test(text)) continue;
      const createdAt = timestamp(value.createdAt, new Date(now).toISOString());
      items.push({
        id: typeof value.id === 'string' && value.id ? value.id : itemId(),
        section: value.section, text, pinned: value.pinned === true, source: typeof value.source === 'string' ? value.source : 'import',
        createdAt, updatedAt: timestamp(value.updatedAt, createdAt),
      });
      if (items.length >= MAX_ITEMS) break;
    }
  }
  return {
    version: 1,
    updatedAt: timestamp(raw?.updatedAt, new Date(now).toISOString()),
    meta: {
      revision: Number.isFinite(raw?.meta?.revision) ? raw.meta.revision : 0,
      turnsSince: Number.isFinite(raw?.meta?.turnsSince) ? Math.max(0, raw.meta.turnsSince) : 0,
      lastConsolidatedAt: Number.isFinite(raw?.meta?.lastConsolidatedAt) ? raw.meta.lastConsolidatedAt : 0,
      lastAttemptAt: Number.isFinite(raw?.meta?.lastAttemptAt) ? raw.meta.lastAttemptAt : 0,
    },
    items, blocked,
  };
}

export class MemoryStore {
  constructor({ dataDir, file = null, now = () => Date.now() }) {
    this.file = file || path.join(dataDir, 'work-memory.json');
    this.now = now;
    this.error = '';
    let raw = null;
    try { raw = readJson(this.file, null); }
    catch { this.error = '本地记忆文件损坏，已改用空记忆'; }
    this.value = normalize(raw, this.now());
  }

  get items() { return this.value.items; }
  get blocked() { return this.value.blocked; }
  stats() {
    return {
      items: this.items.length, itemLimit: MAX_ITEMS, error: this.error,
      turnsSince: this.value.meta.turnsSince, lastConsolidatedAt: this.value.meta.lastConsolidatedAt,
      lastAttemptAt: this.value.meta.lastAttemptAt, blockBytes: Buffer.byteLength(this.block(), 'utf8'), blockLimit: MAX_BLOCK_BYTES,
    };
  }

  // The compact system block. Pinned items stay; non-pinned episodes are the
  // first to be dropped when the 4 KB budget is exceeded.
  block() {
    if (!this.items.length) return '';
    const bySection = new Map(Object.keys(SECTIONS).map(section => [section, []]));
    for (const item of this.items) bySection.get(item.section)?.push(item);
    for (const list of bySection.values()) list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const display = new Map([...bySection].map(([section, list]) => [section, list.map(item => ({ ...item }))]));
    const render = () => {
      const lines = ['[长期记忆]'];
      for (const [section, label] of Object.entries(SECTIONS)) {
        const list = display.get(section) || [];
        if (!list.length) continue;
        lines.push(label + '：' + list.map(item => item.text).join('；'));
      }
      return lines.join('\n');
    };
    const bytes = value => Buffer.byteLength(value, 'utf8');
    let block = render();
    // Drop the oldest unpinned episodes first, then the oldest other unpinned
    // memories. Pinned memories are only truncated as a last resort.
    const candidates = [
      ...(display.get('episodes') || []).filter(item => !item.pinned).map(item => ['episodes', item]),
      ...Object.keys(SECTIONS).filter(section => section !== 'episodes').flatMap(section =>
        (display.get(section) || []).filter(item => !item.pinned).map(item => [section, item])),
    ];
    for (const [section, item] of candidates) {
      if (bytes(block) <= MAX_BLOCK_BYTES) break;
      const list = display.get(section);
      const index = list.indexOf(item);
      if (index >= 0) list.splice(index, 1);
      block = render();
    }
    if (bytes(block) > MAX_BLOCK_BYTES) {
      const raw = Buffer.from(block, 'utf8').subarray(0, MAX_BLOCK_BYTES - 3).toString('utf8');
      block = raw + '…';
    }
    return block;
  }

  public() {
    const block = this.block();
    return {
      version: 1,
      items: structuredClone(this.items),
      blocked: [...this.blocked],
      sections: SECTIONS,
      budget: { bytes: Buffer.byteLength(block, 'utf8'), limit: MAX_BLOCK_BYTES, items: this.items.length, itemLimit: MAX_ITEMS },
      stats: this.stats(),
    };
  }

  persist() {
    this.value.updatedAt = new Date(this.now()).toISOString();
    this.value.meta.revision += 1;
    try { writeJson(this.file, this.value); this.error = ''; }
    catch (error) { this.error = '记忆保存失败'; throw error; }
  }

  trim() {
    while (this.items.length > MAX_ITEMS) {
      const index = this.items.findIndex(item => !item.pinned);
      if (index < 0) break;
      this.items.splice(index, 1);
    }
  }

  saveItem({ section, text, pinned, source = 'chat' }, { updateId = '' } = {}) {
    if (updateId) {
      const item = this.items.find(value => value.id === updateId);
      if (!item) throw new Error('找不到这条记忆');
      if (text !== undefined) {
        const clean = textOf(text);
        if (!clean || CONTROL.test(clean)) throw new Error('记忆内容不能为空');
        if (SECRET.test(clean)) throw new Error('不要保存密钥、密码或令牌');
        item.text = clean;
      }
      if (pinned !== undefined) item.pinned = !!pinned;
      item.updatedAt = new Date(this.now()).toISOString();
      this.persist();
      return this.public();
    }
    const item = makeItem(section, text, this.now(), source, pinned === true);
    const duplicate = this.items.find(value => normalized(value.text) === normalized(item.text));
    if (duplicate) {
      if (pinned === true) duplicate.pinned = true;
      duplicate.updatedAt = item.updatedAt;
      this.persist();
      return this.public();
    }
    const inSection = this.items.filter(value => value.section === section);
    if (inSection.length >= LIMITS[section]) {
      const oldest = inSection.find(value => !value.pinned);
      if (!oldest) throw new Error('这个分组已经记满，请先删除一条');
      this.items.splice(this.items.indexOf(oldest), 1);
    }
    if (this.items.length >= MAX_ITEMS) {
      const oldest = this.items.find(value => !value.pinned);
      if (!oldest) throw new Error('记忆已满，请先删除一条');
      this.items.splice(this.items.indexOf(oldest), 1);
    }
    this.items.push(item);
    this.trim();
    this.persist();
    return this.public();
  }

  update(id, patch = {}) {
    const item = this.items.find(value => value.id === id);
    if (!item) throw new Error('找不到这条记忆');
    if (patch.text !== undefined) {
      const clean = textOf(patch.text);
      if (!clean || CONTROL.test(clean)) throw new Error('记忆内容不能为空');
      if (SECRET.test(clean)) throw new Error('不要保存密钥、密码或令牌');
      item.text = clean;
    }
    if (patch.pinned !== undefined) item.pinned = patch.pinned === true;
    item.updatedAt = new Date(this.now()).toISOString();
    this.persist();
    return this.public();
  }

  remove(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.persist();
    return true;
  }

  forget({ id = '', text = '', block = false } = {}) {
    let matches = [];
    if (typeof id === 'string' && id) matches = this.items.filter(item => item.id === id);
    else {
      const needle = normalized(textOf(text));
      if (!needle) throw new Error('请告诉我要忘掉哪条记忆');
      matches = this.items.filter(item => normalized(item.text).includes(needle));
    }
    if (!matches.length) return { ok: false, error: '没有找到匹配的记忆' };
    if (matches.length > 1) return { ok: false, candidates: matches.map(item => ({ id: item.id, text: item.text })) };
    const item = matches[0];
    this.items.splice(this.items.indexOf(item), 1);
    if (block) {
      const topic = textOf(text || item.text);
      if (topic && !this.blocked.includes(topic)) {
        this.blocked.push(topic);
        while (this.blocked.length > MAX_BLOCKED) this.blocked.shift();
      }
    }
    this.persist();
    return { ok: true, removed: item.id, memory: this.public() };
  }

  clear() {
    this.items = [];
    this.persist();
    return this.public();
  }

  // A consolidation diff is applied in one pass; invalid or secret entries are
  // skipped instead of failing the whole batch.
  applyDiff(diff, source = 'consolidation') {
    const result = { added: 0, updated: 0, removed: 0, skipped: 0 };
    if (!diff || typeof diff !== 'object') return result;
    if (Array.isArray(diff.remove)) {
      for (const id of diff.remove) {
        const index = typeof id === 'string' ? this.items.findIndex(item => item.id === id) : -1;
        // Pinned items are only removed by the user, never by a consolidation
        // diff the model produced.
        if (index >= 0 && !this.items[index].pinned) { this.items.splice(index, 1); result.removed += 1; }
        else result.skipped += 1;
      }
    }
    for (const patch of Array.isArray(diff.update) ? diff.update : []) {
      if (!patch || typeof patch !== 'object') { result.skipped += 1; continue; }
      const item = this.items.find(value => value.id === patch.id);
      const clean = textOf(patch.text);
      if (!item || !clean || SECRET.test(clean) || CONTROL.test(clean)) { result.skipped += 1; continue; }
      item.text = clean; item.updatedAt = new Date(this.now()).toISOString();
      if (patch.pinned === true) item.pinned = true;
      result.updated += 1;
    }
    for (const add of Array.isArray(diff.add) ? diff.add : []) {
      try {
        const item = makeItem(add?.section, add?.text, this.now(), source, add?.pinned === true);
        if (this.items.some(value => normalized(value.text) === normalized(item.text))) { result.skipped += 1; continue; }
        const inSection = this.items.filter(value => value.section === item.section);
        if (inSection.length >= LIMITS[item.section]) {
          const oldest = inSection.find(value => !value.pinned);
          if (!oldest) { result.skipped += 1; continue; }
          this.items.splice(this.items.indexOf(oldest), 1);
        }
        if (this.items.length >= MAX_ITEMS) {
          const oldest = this.items.find(value => !value.pinned);
          if (!oldest) { result.skipped += 1; continue; }
          this.items.splice(this.items.indexOf(oldest), 1);
        }
        this.items.push(item); result.added += 1;
      } catch { result.skipped += 1; }
    }
    if (Array.isArray(diff.blocked)) {
      for (const value of diff.blocked) {
        const clean = textOf(value);
        if (clean && !SECRET.test(clean) && !this.blocked.includes(clean)) {
          this.blocked.push(clean);
          while (this.blocked.length > MAX_BLOCKED) this.blocked.shift();
        }
      }
    }
    this.trim();
    this.persist();
    return result;
  }

  noteTurn() {
    this.value.meta.turnsSince += 1;
    this.persist();
  }

  markAttempt(success) {
    this.value.meta.lastAttemptAt = this.now();
    if (success) { this.value.meta.lastConsolidatedAt = this.now(); this.value.meta.turnsSince = 0; }
    this.persist();
  }
}
