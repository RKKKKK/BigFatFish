// Shared by the runtime and the page: the dispatcher serves this file at /lib/event-stream.js, and the
// relative import below resolves to /vendor/... in the browser and to the repo's vendor folder in Node.
import { createParser } from '../vendor/eventsource-parser/dist/index.js';

export async function* readEvents(body) {
  if (!body) throw new Error('响应没有流式内容');
  const reader = body.getReader(), decoder = new TextDecoder(), queue = [];
  const parser = createParser({ maxBufferSize: 1024 * 1024, onEvent: event => queue.push(event) });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      parser.feed(done ? decoder.decode() : decoder.decode(value, { stream: true }));
      while (queue.length) yield queue.shift();
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
