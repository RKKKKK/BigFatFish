import readline from 'node:readline';
import path from 'node:path';
import { ensureService, serviceRequest, launchDesktop } from './process.mjs';
import { DATA_HOME, VERSION, readJson } from './paths.mjs';

const toolSpecs = [
  { name: 'whale_balance', description: '查询大肥鱼汇总的所有额度账户：Codex 与 Claude 订阅的 5 小时、7 天剩余，API 账户（如 Codex 中转站、大肥鱼用的 DeepSeek）的额度、余额、今日消费与消耗速度，以及挂件当前显示哪个账户。不返回密钥。', inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: '立即重新查询各 API 账户' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'whale_usage', description: '读取每个额度账户近 30 天的每日消费（共用账户拆成 Codex 任务与大肥鱼）、最近的 Codex 任务与大肥鱼请求明细，以及 Codex 订阅最近几轮后剩余的额度。不返回密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'whale_status', description: '读取挂件状态、Codex 会话用量监听状态，以及全部额度账户与当前显示的账户；不返回 API 密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'whale_open', description: '显示独立常驻桌面的 API 余额小鲸鱼。挂件不绑定 Codex 窗口，可由托盘或快捷键隐藏；没有网页地址，角色、音效、气泡编辑和资源管理均在挂件中操作。', inputSchema: { type: 'object', properties: { desktop: { type: 'boolean', description: '显示桌面透明悬浮挂件' } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
];

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function dispatch(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'api-balance-whale', version: VERSION } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: toolSpecs };
    else if (method === 'resources/list' || method === 'resources/templates/list') result = method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] };
    else if (method === 'tools/call') {
      const args = params.arguments || {};
      let output;
      if (params.name === 'whale_balance') output = await serviceRequest('/api/quotas' + (args.refresh ? '?refresh=1' : ''));
      else if (params.name === 'whale_usage') output = await serviceRequest('/api/quota-records');
      else if (params.name === 'whale_status') output = { ...await serviceRequest('/api/status'), quotas: await serviceRequest('/api/quotas') };
      else if (params.name === 'whale_open') {
        if (args.desktop) output = await launchDesktop();
        else output = await launchDesktop();
      } else throw new Error('未知工具');
      result = { content: [{ type: 'text', text: JSON.stringify(output) }], isError: output.ok === false };
    } else { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
    send({ jsonrpc: '2.0', id, result });
  } catch { send({ jsonrpc: '2.0', id, error: { code: -32603, message: '挂件操作失败，请确认桌面组件已安装且服务正在运行' } }); }
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (line.length > 1024 * 1024) return;
  try { const message = JSON.parse(line); if (message.jsonrpc === '2.0') dispatch(message); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
});
input.on('close', () => process.exit(0));
