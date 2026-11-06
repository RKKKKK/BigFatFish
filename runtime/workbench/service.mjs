import { WorkbenchSettings } from './settings.mjs';
import { MemoryStore } from './memory.mjs';

// The task list the independent workbench window reads. Task rows themselves
// come from the same board the always-on task window uses, so both surfaces
// agree; this service adds the summary counts and the workbench settings.
function summarize(rows) {
  const counts = { total: rows.length, running: 0, waiting: 0, stuck: 0, done: 0, failed: 0, idle: 0, byTool: { codex: 0, dsh: 0, claude: 0 } };
  for (const row of rows) {
    if (row.tool && Object.hasOwn(counts.byTool, row.tool)) counts.byTool[row.tool] += 1;
    if (row.state === 'running') counts.running += 1;
    else if (row.state === 'question' || row.state === 'permission') counts.waiting += 1;
    else if (row.state === 'stuck') counts.stuck += 1;
    else if (row.state === 'done') counts.done += 1;
    else if (row.state === 'failed' || row.state === 'aborted') counts.failed += 1;
    else counts.idle += 1;
  }
  return counts;
}

export class WorkbenchService {
  constructor({ dataDir, agents, limits = () => null, now = () => Date.now() }) {
    this.agents = agents;
    this.limits = limits;
    this.settings = new WorkbenchSettings(dataDir);
    this.memory = new MemoryStore({ dataDir, now });
    this.runner = null;
    this.now = now;
  }

  attachRunner(runner) { this.runner = runner; }

  snapshot() {
    const rows = this.agents.rows();
    const dispatched = this.runner?.snapshot?.() || { drafts: [], tasks: [], active: 0, queue: [], maxConcurrent: 2 };
    return {
      ok: true,
      generatedAt: new Date(this.now()).toISOString(),
      rows,
      counts: summarize(rows),
      dsh: typeof this.agents.dshStatus === 'function' ? this.agents.dshStatus() : null,
      settings: this.settings.public(),
      memory: this.memory.stats(),
      limits: typeof this.limits === 'function' ? this.limits() : null,
      drafts: dispatched.drafts || [],
      runner: { active: dispatched.active || 0, queue: dispatched.queue || [], maxConcurrent: dispatched.maxConcurrent || 2 },
    };
  }

  task(id) {
    const dispatched = this.runner?.find?.(id);
    if (dispatched) {
      const row = this.runner.rows().find(item => item.taskId === dispatched.id) || null;
      return row ? { ok: true, row, task: this.runner.find(id) } : { ok: true, task: this.runner.find(id) };
    }
    const row = this.agents.find(id);
    return row ? { ok: true, row } : { ok: false, error: '这个任务已经不在了' };
  }

  publicSettings() { return { ok: true, settings: this.settings.public() }; }
  saveSettings(input) { return { ok: true, settings: this.settings.save(input) }; }

  createDraft(input) { return { ok: true, draft: this.runner.createDraft(input) }; }
  startDraft(id, options) { return { ok: true, task: this.runner.startDraft(id, options) }; }
  cancelDraft(id, options) { return { ok: true, cancelled: this.runner.cancelDraft(id, options) }; }
  stopTask(id, options) { return { ok: true, task: this.runner.stop(id, options) }; }

  taskEvents(id) {
    if (!this.runner || typeof this.runner.events !== 'function') return { ok: false, error: '任务输出不可用' };
    return this.runner.events(id);
  }

  memorySnapshot() { return { ok: true, memory: this.memory.public() }; }

  // The workbench memory tab edits the same store the chat tool writes. The
  // action shape is intentionally small: save, update, forget, clear.
  memoryAction(input = {}) {
    const action = input?.action;
    if (action === 'save') {
      return { ok: true, memory: this.memory.saveItem({ section: input.section, text: input.text, pinned: input.pinned === true, source: 'user' }) };
    }
    if (action === 'update') {
      return { ok: true, memory: this.memory.update(input.id, { ...(input.text !== undefined ? { text: input.text } : {}), ...(input.pinned !== undefined ? { pinned: input.pinned === true } : {}) }) };
    }
    if (action === 'forget') {
      const result = this.memory.forget({ id: input.id, text: input.text, block: input.block === true });
      return result.ok ? { ...result, memory: this.memory.public() } : { ...result, memory: this.memory.public() };
    }
    if (action === 'clear') return { ok: true, memory: this.memory.clear() };
    throw new Error('无效的记忆操作');
  }

  close() {}
}
