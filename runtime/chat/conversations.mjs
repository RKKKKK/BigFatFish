import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../paths.mjs';

const createConversation = (turns = [], kind = 'normal') => {
  const now = new Date().toISOString();
  return { id: randomUUID(), createdAt: turns[0]?.createdAt || now,
    updatedAt: turns.at(-1)?.createdAt || now, kind, turns };
};

export class Conversations {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'chat-history.json');
    const stored = readJson(this.file, { turns: [] });
    if (stored.version === 2) {
      if (!Array.isArray(stored.conversations) || !stored.conversations.length ||
          stored.conversations.some(item => !item || typeof item.id !== 'string' || !Array.isArray(item.turns)) ||
          new Set(stored.conversations.map(item => item.id)).size !== stored.conversations.length ||
          !stored.conversations.some(item => item.id === stored.currentId)) throw new Error('会话历史格式无效');
      this.items = stored.conversations; this.currentId = stored.currentId;
    } else {
      if (!Array.isArray(stored.turns)) throw new Error('会话历史格式无效');
      this.items = [createConversation(stored.turns)]; this.currentId = this.items[0].id;
      if (fs.existsSync(this.file)) {
        const backup = path.join(dataDir, 'chat-history.v1.json');
        if (!fs.existsSync(backup)) writeJson(backup, stored);
        this.commit(this.items, this.currentId);
      }
    }
    for (const item of this.items) {
      item.turns = item.turns.map(turn => turn.status === 'streaming' ? { ...turn, status: 'interrupted' } : turn);
    }
  }
  get current() { return this.items.find(item => item.id === this.currentId); }
  find(id) { return this.items.find(item => item.id === id) || null; }
  allTurns() { return this.items.flatMap(item => item.turns); }
  list() {
    return this.items.map(item => ({ id: item.id, kind: item.kind || 'normal', title: item.kind === 'spontaneous' ? '随便聊聊' : [...String(item.turns[0]?.user || '新会话').replace(/\s+/g, ' ')].slice(0, 48).join(''),
      createdAt: item.createdAt, updatedAt: item.updatedAt, messages: item.turns.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  commit(items, currentId) {
    writeJson(this.file, { version: 2, currentId, conversations: items });
    this.items = items; this.currentId = currentId;
  }
  persist() {
    this.saveTurns(this.currentId, this.current.turns);
  }
  saveTurns(id, source) {
    const turns = [...source];
    while (turns.length > 60 || JSON.stringify(turns).length > 512 * 1024 && turns.length > 1) turns.shift();
    this.commit(this.items.map(item => item.id === id ? { ...item, turns, updatedAt: new Date().toISOString() } : item), this.currentId);
  }
  spontaneous() {
    let item = this.items.find(item => item.kind === 'spontaneous');
    if (!item) {
      item = createConversation([], 'spontaneous');
      this.commit([...this.items, item], this.currentId);
    }
    return item;
  }
  appendTo(id, turn) {
    const item = this.items.find(row => row.id === id);
    if (!item) throw new Error('会话不存在');
    this.saveTurns(id, [...item.turns, turn]);
  }
  create() {
    const item = createConversation(); this.commit([...this.items, item], item.id);
  }
  select(id) {
    if (!this.items.some(item => item.id === id)) throw new Error('会话不存在');
    this.commit(this.items, id);
  }
  remove(id) {
    if (!this.items.some(item => item.id === id)) throw new Error('会话不存在');
    const items = this.items.filter(item => item.id !== id);
    if (!items.length) items.push(createConversation());
    const currentId = id === this.currentId ? items.reduce((last, item) => item.updatedAt > last.updatedAt ? item : last).id : this.currentId;
    this.commit(items, currentId);
  }
}
