import { complete, visibleError } from './provider.mjs';
import { billingUsage, officialDeepSeek } from './deepseek-pricing.mjs';
import { timeNote, timeTag } from './time-context.mjs';

// Model requests that may follow tool calls; the last one is offered no tools, so it answers in text.
const FOLLOW_UPS = 2;

function addUsage(total, usage) {
  const result = { ...total };
  for (const [key, value] of Object.entries(usage)) if (typeof value === 'number' && Number.isFinite(value)) result[key] = (result[key] || 0) + value;
  return result;
}

function context(turns) {
  const messages = turns.flatMap(turn => [
    ...(turn.user ? [{ role: 'user', content: timeTag(turn.createdAt) + turn.user }] : []), ...(turn.text ? [{ role: 'assistant', content: turn.text }] : [])
  ]);
  while (messages.length && messages.reduce((n, message) => n + message.content.length, 0) > 48000) messages.shift();
  return messages;
}

function taskRef(item) {
  if (!item || typeof item.id !== 'string' || !item.id) return null;
  const title = String(item.prompt || item.title || item.id).replace(/\s+/g, ' ').slice(0, 80);
  return { id: item.id, title, tool: item.tool || '', status: item.status || '' };
}

export function taskRefsFromResult(result) {
  if (!result || result.ok !== true) return [];
  const items = Array.isArray(result.tasks) ? result.tasks : result.task ? [result.task] : result.draft ? [result.draft] : [];
  return items.map(taskRef).filter(Boolean);
}

// One character reply: framing, then model requests until one answers in text,
// each billed on its own. It never writes history; the caller
// decides whether the result still applies. The result is always returned,
// with `status` completed, cancelled or failed and a user-facing `error`.
export async function generateReply({ endpoint, persona = '', capabilities = '', memory = '', instruction = '', history = [], prompt, tools = null, id, now = Date.now(),
  fetchImpl = fetch, record = () => {}, signal, timeoutMs = Infinity, idleMs = Infinity, maxChars = Infinity, onDelta = () => {} }) {
  const reply = { status: 'failed', text: '', usage: undefined, finishReason: undefined, requests: [], taskRefs: [], error: '' };
  const controller = new AbortController(), credentials = { baseUrl: endpoint.baseUrl, key: endpoint.key };
  let timedOut = false, idle = null;
  const expire = () => { timedOut = true; controller.abort(); };
  const cancel = () => controller.abort();
  const resetIdle = () => { if (Number.isFinite(idleMs)) { clearTimeout(idle); idle = setTimeout(expire, idleMs); idle.unref?.(); } };
  const timer = Number.isFinite(timeoutMs) ? setTimeout(expire, timeoutMs) : null;
  timer?.unref?.();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  resetIdle();
  try {
    const offered = tools && officialDeepSeek(endpoint.baseUrl) ? tools : null;
    const earlier = history.filter(turn => turn.status === 'completed').slice(-20);
    const messages = [
      ...(persona ? [{ role: 'system', content: persona }] : []),
      ...(capabilities ? [{ role: 'system', content: capabilities }] : []),
      { role: 'system', content: timeNote() },
      ...(memory ? [{ role: 'system', content: memory }] : []),
      ...(instruction ? [{ role: 'system', content: instruction }] : []),
      ...(offered?.policy ? [{ role: 'system', content: offered.policy }] : []),
      ...context(earlier),
      { role: 'user', content: timeTag(now, earlier.at(-1)?.createdAt) + prompt }
    ];
    const settings = { baseUrl: endpoint.baseUrl, model: endpoint.model, maxTokens: endpoint.maxTokens };
    for (let index = 0; index <= FOLLOW_UPS; index++) {
      if (controller.signal.aborted) throw new Error('aborted');
      const request = { id: index ? id + ':' + index : id, model: endpoint.model, createdAt: new Date().toISOString(), status: 'streaming' };
      reply.requests.push(request); record(request, credentials);
      let calls = null, requestText = '', reasoning = '';
      try {
        for await (const event of complete({ settings, key: endpoint.key, messages, fetchImpl, signal: controller.signal, tools: offered && index < FOLLOW_UPS ? offered.definitions : null })) {
          if (controller.signal.aborted) throw new Error('aborted');
          resetIdle();
          if (event.type === 'delta') {
            requestText += event.text; reply.text += event.text;
            if (reply.text.length > maxChars) throw visibleError('回复内容超过本地长度限制');
            onDelta(event.text);
          } else if (event.type === 'finish' && event.reason !== 'tool_calls') reply.finishReason = event.reason;
          else if (event.type === 'usage') request.usage = billingUsage(event.usage) || undefined;
          else if (event.type === 'tool_calls') { calls = event.calls; reasoning = event.reasoning; }
        }
        request.status = 'completed';
      } catch (error) { request.status = controller.signal.aborted ? 'cancelled' : 'failed'; throw error; }
      finally {
        if (request.usage) reply.usage = addUsage(reply.usage, request.usage);
        record(request, credentials);
      }
      if (!calls) break;
      const assistant = { role: 'assistant', content: requestText || null, tool_calls: calls };
      if (reasoning) assistant.reasoning_content = reasoning;
      messages.push(assistant);
      for (const call of calls) {
        let result;
        try { result = await offered.execute({ name: call.function.name, arguments: call.function.arguments }); }
        catch { result = { ok: false, error: '操作未能保存' }; }
        for (const ref of taskRefsFromResult(result)) {
          if (!reply.taskRefs.some(item => item.id === ref.id)) reply.taskRefs.push(ref);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    if (controller.signal.aborted) throw new Error('aborted');
    if (!reply.text) throw visibleError('模型没有返回文字回复');
    reply.status = 'completed';
  } catch (error) {
    reply.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
    reply.error = timedOut ? '回复超时，请重试' : controller.signal.aborted ? '已停止生成' :
      String(error?.message).includes(endpoint.key) ? '会话请求失败，请检查设置后重试' : error?.visible ? error.message : '会话连接失败，请检查网络或接口地址';
  } finally {
    clearTimeout(timer); clearTimeout(idle); signal?.removeEventListener('abort', cancel);
  }
  return reply;
}
