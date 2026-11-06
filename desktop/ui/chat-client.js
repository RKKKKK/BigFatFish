import { readEvents } from '../../lib/event-stream.js';

export function createChatClient(fetchImpl = window.fetch.bind(window)) {
  async function request(route, method = 'GET', body) {
    const response = await fetchImpl('/api/chat/' + route, { method, cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || '会话操作失败');
    }
    return response;
  }
  return Object.freeze({
    settings: async () => (await request('settings')).json(),
    save: async settings => (await request('settings', 'PUT', settings)).json(),
    history: async () => (await request('history')).json(),
    conversations: async () => (await request('conversations')).json(),
    createConversation: async () => (await request('conversations', 'POST')).json(),
    selectConversation: async id => (await request('conversations', 'PUT', { id })).json(),
    deleteConversation: async id => (await request('conversations', 'DELETE', { id })).json(),
    billing: async force => (await request('billing' + (force ? '?refresh=1' : ''))).json(),
    activity: async () => (await request('activity')).json(),
    activitySettings: async () => (await request('activity/settings')).json(),
    saveActivitySettings: async settings => (await request('activity/settings', 'PUT', settings)).json(),
    ackActivity: async seq => (await request('activity/ack', 'POST', { seq })).json(),
    advancePomodoro: async reminder => (await request('activity/advance', 'POST', reminder)).json(),
    presence: async busy => (await request('activity/presence', 'POST', { busy })).json(),
    clear: async () => (await request('history', 'DELETE')).json(),
    stop: async id => (await request('stop', 'POST', { id })).json(),
    send: async (id, text, onEvent, conversationId) => {
      const response = await request('message', 'POST', { id, text, conversationId });
      let done = false;
      for await (const event of readEvents(response.body)) {
        const data = JSON.parse(event.data);
        if (data.id !== id) throw new Error('会话消息标识不匹配');
        onEvent(data);
        if (data.type === 'done') { done = true; break; }
      }
      if (!done) throw new Error('会话连接已断开，请重新打开会话查看保存的回复');
    },
  });
}
