import { readEvents } from '../../lib/event-stream.js';

export function completionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写有效的会话 API 地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:') || url.username || url.password || url.search || url.hash) {
    throw new Error('会话 API 地址须为 HTTPS（本机服务可用 HTTP），不能包含密钥或查询参数');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

// Errors whose message is safe to show the user as the reply's failure reason.
export const visibleError = message => Object.assign(new Error(message), { visible: true });

export async function* complete({ settings, key, messages, fetchImpl, signal, tools }) {
  const response = await fetchImpl(completionUrl(settings.baseUrl), {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: settings.model, messages, max_tokens: settings.maxTokens, stream: true, stream_options: { include_usage: true }, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const detail = response.status === 401 || response.status === 403 ? '请检查 API key 与模型权限' :
      response.status === 429 ? '请求过于频繁或额度不足，请稍后重试' : '请检查接口地址、模型名称和回复长度';
    throw visibleError('会话接口返回 ' + response.status + '，' + detail);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw visibleError('会话接口未返回 SSE 流式响应，请检查接口协议');
  }
  let finished = false, finishReason = '', reasoning = '';
  const calls = new Map();
  for await (const event of readEvents(response.body)) {
    if (event.data === '[DONE]') { finished = true; break; }
    let data;
    try { data = JSON.parse(event.data); } catch { throw visibleError('会话接口返回了无效的流式数据'); }
    if (data.error) throw visibleError('会话接口报告生成失败，请检查模型配置后重试');
    const choice = data.choices?.find(item => item.index === 0) || data.choices?.[0];
    if (typeof choice?.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content;
    if (reasoning.length > 128000) throw visibleError('模型工具调用过长');
    for (const fragment of choice?.delta?.tool_calls || []) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index > 7) throw visibleError('模型工具调用格式无效');
      const call = calls.get(fragment.index) || { id: '', type: '', function: { name: '', arguments: '' } };
      if (fragment.id) call.id = fragment.id;
      if (fragment.type) call.type = fragment.type;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      if (call.function.arguments.length > 4096 || call.function.name.length > 128) throw visibleError('模型工具调用过长');
      calls.set(fragment.index, call);
    }
    if (typeof choice?.delta?.content === 'string' && choice.delta.content) yield { type: 'delta', text: choice.delta.content };
    if (choice?.finish_reason) { finishReason = choice.finish_reason; yield { type: 'finish', reason: finishReason }; }
    if (data.usage) yield { type: 'usage', usage: data.usage };
  }
  if (!finished) throw visibleError('连接提前结束，回复未完成');
  if (calls.size) {
    if (finishReason !== 'tool_calls' || !tools?.length) throw visibleError('模型工具调用格式无效');
    const result = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    if (result.some(call => !call.id || call.id.length > 128 || call.type !== 'function' || !call.function.name) ||
        new Set(result.map(call => call.id)).size !== result.length) throw visibleError('模型工具调用格式无效');
    yield { type: 'tool_calls', calls: result, reasoning };
  }
}
