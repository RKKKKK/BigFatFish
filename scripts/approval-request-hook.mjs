import { bridgeRequest } from '../runtime/bridge.mjs';

const dataIndex = process.argv.indexOf('--data-dir');
const dataDir = dataIndex >= 0 ? process.argv[dataIndex + 1] : '';
if (process.argv.includes('--whale-approval-hook') && dataDir) {
  try {
    let input = '';
    for await (const part of process.stdin) {
      input += part;
      if (input.length > 65536) throw new Error('hook input too large');
    }
    const event = JSON.parse(input);
    if (event.hook_event_name === 'PermissionRequest') {
      // Only which session asks leaves this process, never what it asks for.
      await bridgeRequest('/internal/approval-request', {
        method: 'POST', body: { event: 'PermissionRequest', sessionId: event.session_id, cwd: event.cwd }, dataDir, timeoutMs: 1200,
      });
    }
  } catch {
    // A stopped whale must never delay or change the normal approval prompt.
  }
}
