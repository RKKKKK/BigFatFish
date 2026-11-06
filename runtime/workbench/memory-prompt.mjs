import { SECTIONS } from './memory.mjs';

// The consolidation call is a separate, small model request over the last few
// completed exchanges. It returns a diff, not a new memory file, so the local
// store stays the single owner of ids, caps and secret filtering.
export const MEMORY_INSTRUCTION = [
  '你是大肥鱼的长期记忆整理器。',
  '只保留跨对话仍然有用的事实：用户希望你怎么称呼、稳定偏好、长期要求、项目背景、已经定下的决定、重要近期事件。',
  '不要保留一次性任务、临时状态、寒暄、密钥、密码、令牌。',
  '每条不超过 80 字；能合并就合并；被新事实取代时用 update；明确过时或用户要求忘掉的用 remove。',
  '用户说“记住 / 以后都 / 不要”的优先；用户说“忘掉”时用 remove，并可以在 blocked 里写下这个话题，避免以后再被自动记住。',
  '只输出严格 JSON，不要 Markdown、不要解释。没有变化就输出 {"add":[],"update":[],"remove":[]}。',
  'JSON 格式：{"add":[{"section":"identity|preferences|longTerm|projects|decisions|episodes","text":"..."}],"update":[{"id":"m-...","text":"..."}],"remove":["m-..."],"blocked":["..."]}。',
].join('\n');

export const MEMORY_SECTIONS = Object.keys(SECTIONS);

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function memoryLines(memory) {
  const items = Array.isArray(memory?.items) ? memory.items : [];
  if (!items.length) return '（空）';
  return items.map(item => '- ' + item.id + ' [' + (SECTIONS[item.section] || item.section) + '] ' + item.text + (item.pinned ? '（重要）' : '')).join('\n');
}

function exchanges(turns, limit = 12) {
  return Array.isArray(turns) ? turns
    .filter(turn => turn && turn.status === 'completed' && (turn.user || turn.text))
    .slice(-limit)
    .map(turn => {
      const parts = [];
      if (turn.user) parts.push('用户：' + text(turn.user, 500));
      if (turn.text) parts.push('大肥鱼：' + text(turn.text, 500));
      return parts.join('\n');
    })
    .filter(Boolean) : [];
}

export function buildConsolidationPrompt(memory, turns) {
  const body = exchanges(turns);
  const lines = [
    '[现有记忆（id 用于 update/remove）]',
    memoryLines(memory),
    '',
    '[禁止记住的话题]',
    Array.isArray(memory?.blocked) && memory.blocked.length ? memory.blocked.join('；') : '（无）',
    '',
    '[最近对话]',
    body.length ? body.join('\n\n') : '（没有可整理的对话）',
  ];
  return lines.join('\n');
}

export function buildBootstrapPrompt(memory, turns) {
  return buildConsolidationPrompt(memory, turns) + '\n\n这是第一次从已有聊天记录初始化记忆。只提取长期有效的内容，不要把所有细节都抄进来。';
}

export function parseMemoryDiff(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const start = value.indexOf('{'), end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(value.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = { add: [], update: [], remove: [], blocked: [] };
  if (Array.isArray(parsed.add)) {
    for (const item of parsed.add.slice(0, 20)) {
      if (item && typeof item === 'object' && MEMORY_SECTIONS.includes(item.section) && typeof item.text === 'string') {
        result.add.push({ section: item.section, text: item.text, pinned: item.pinned === true });
      }
    }
  }
  if (Array.isArray(parsed.update)) {
    for (const item of parsed.update.slice(0, 20)) {
      if (item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string') {
        result.update.push({ id: item.id, text: item.text });
      }
    }
  }
  if (Array.isArray(parsed.remove)) {
    for (const id of parsed.remove.slice(0, 20)) if (typeof id === 'string') result.remove.push(id);
  }
  if (Array.isArray(parsed.blocked)) {
    for (const value of parsed.blocked.slice(0, 10)) if (typeof value === 'string') result.blocked.push(value);
  }
  return result;
}
