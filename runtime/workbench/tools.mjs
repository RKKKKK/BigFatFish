import { SECTIONS } from './memory.mjs';

// Memory tools are pre-authorized and only touch the local memory file. The
// model decides what to save, but the store validates section, length, secrets
// and budgets. A one-off task must never become a long-term memory.
export const MEMORY_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description: '读取已经保存的长期记忆，用于回答“你记得我什么”或确认某件事是否记过。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: '保存一条跨对话仍然有用的长期记忆。只用于用户明确说出的称呼、偏好、长期要求、项目背景或已定决策；一次性任务和临时状态不要用。',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: Object.keys(SECTIONS), description: 'identity=称呼/身份，preferences=偏好，longTerm=长期要求，projects=项目，decisions=已定决定，episodes=重要近期事件' },
          text: { type: 'string', minLength: 1, maxLength: 160, description: '一到两句中文，尽量精炼' },
          pinned: { type: 'boolean', description: '用户明确要求“记住”时设为 true，整理时不会自动删掉' },
        },
        required: ['section', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: '忘掉一条记忆。用户明确说“忘掉/别记”时使用；可以按 id 或按内容片段匹配。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的记忆 id，优先使用' },
          text: { type: 'string', maxLength: 160, description: '没有 id 时，用一段内容来匹配' },
          block: { type: 'boolean', description: '同时把这个话题加入禁止记住列表，避免以后自动加回' },
        },
        additionalProperties: false,
      },
    },
  },
]);

export const MEMORY_POLICY = [
  '记忆工具已经预授权，会在本地立即执行。',
  '只在用户说出长期有用的称呼、偏好、长期要求、项目背景或已定决策时调用 memory_save；一次性任务、临时状态、寒暄不要记。',
  '不要保存密钥、密码、令牌、身份证号等敏感信息。',
  '用户说“记住 / 以后都 / 不要”时保存并把 pinned 设为 true；用户说“忘掉”时删除，必要时把话题加入 block。',
  '不确定是否长期有效时先问一句，不要擅自保存。',
].join('\n');

export function createMemoryTools({ memory }) {
  if (!memory) return null;
  return {
    definitions: MEMORY_TOOLS,
    policy: MEMORY_POLICY,
    execute(call) {
      if (!call || typeof call !== 'object' || typeof call.arguments !== 'string' || call.arguments.length > 4096) {
        return { ok: false, error: '操作参数格式无效' };
      }
      let args;
      try { args = JSON.parse(call.arguments); } catch { return { ok: false, error: '操作参数格式无效' }; }
      try {
        if (call.name === 'memory_list') return { ok: true, memory: memory.public() };
        if (call.name === 'memory_save') {
          const before = new Set(memory.items.map(item => item.id));
          const view = memory.saveItem({ section: args.section, text: args.text, pinned: args.pinned === true, source: 'chat' });
          const saved = view.items.find(item => !before.has(item.id)) || view.items.find(item => item.text === String(args.text || '').trim());
          return { ok: true, saved: saved ? { id: saved.id, section: saved.section, text: saved.text, pinned: saved.pinned } : null, budget: view.budget };
        }
        if (call.name === 'memory_forget') {
          const result = memory.forget({ id: typeof args.id === 'string' ? args.id : '', text: typeof args.text === 'string' ? args.text : '', block: args.block === true });
          return result;
        }
        return { ok: false, error: '未知的记忆操作' };
      } catch (error) {
        return { ok: false, error: error?.message || '记忆操作没有完成' };
      }
    },
  };
}
