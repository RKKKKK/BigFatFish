import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../paths.mjs';
import { IDLE, applyPomodoroCall, expirePomodoro, reminderApplies, advancePomodoro, viewPomodoro, holdsProactiveChat, reminderCanAdvance, upcomingExpiry } from './pomodoro.mjs';

const DEFAULTS = { enabled: false, start: '09:00', end: '21:00', minMinutes: 45, maxMinutes: 90, dailyLimit: 3 };
// A reminder is asked for this long before its phase ends, so it can show on time.
const PREPARE_MS = 60000;
const FALLBACK = { completed: '这轮专注完成了，辛苦啦。', await_break: '专注时间到了，准备休息一下吧。', await_focus: '休息时间到了，准备开始下一轮专注吧。' };
const minute = value => { const match = /^(\d\d):(\d\d)$/.exec(value); return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : null; };
// A file that cannot be read, or does not hold an object, is treated as missing; the next save replaces it.
function readOrDefault(file, fallback) {
  let value = null;
  try { value = readJson(file, fallback); } catch {}
  return value && typeof value === 'object' && !Array.isArray(value) ? value : structuredClone(fallback);
}

// Keeps a generated reply that still applies: commits it to history and yields its
// text and conversation, or null if there is no text or the commit fails.
function settle(generated) {
  if (!generated?.text) return null;
  try { return { text: generated.text, conversationId: generated.commit() }; }
  catch { return null; }
}

export class ChatActivity {
  constructor({ dataDir, now = Date.now, random = Math.random, onProactive = async () => null, onReminder = async () => null, onNotice = () => {}, canProactive = () => true, startTimer = true }) {
    this.configFile = path.join(dataDir, 'chat-activity.json');
    this.stateFile = path.join(dataDir, 'chat-activity-state.json');
    this.now = now; this.random = random; this.onProactive = onProactive; this.onReminder = onReminder; this.onNotice = onNotice; this.canProactive = canProactive;
    this.config = { ...DEFAULTS, ...readOrDefault(this.configFile, {}) };
    const stored = readOrDefault(this.stateFile, {});
    this.pomodoro = stored.pomodoro || IDLE;
    this.notices = Array.isArray(stored.notices) ? stored.notices.slice(-20) : [];
    this.sequence = Number.isSafeInteger(stored.sequence) ? stored.sequence : 0;
    this.acked = Number.isSafeInteger(stored.acked) ? stored.acked : 0;
    this.nextAt = Number.isFinite(stored.nextAt) ? stored.nextAt : 0;
    this.day = stored.day || ''; this.dailyCount = stored.dailyCount || 0;
    this.lastUserAt = stored.lastUserAt || 0; this.lastProactiveAt = stored.lastProactiveAt || 0;
    this.busy = false; this.closed = false; this.proactiveJob = false; this.lastProactiveCheck = 0; this.prepared = null;
    this.presence = { busy: false, at: 0 };
    this.timer = startTimer ? setInterval(() => { void this.tick(); }, 1000) : null;
    this.timer?.unref();
    if (startTimer) void this.tick();
  }
  persist() { writeJson(this.stateFile, { pomodoro: this.pomodoro, notices: this.notices, sequence: this.sequence, acked: this.acked, nextAt: this.nextAt, day: this.day, dailyCount: this.dailyCount, lastUserAt: this.lastUserAt, lastProactiveAt: this.lastProactiveAt }); }
  settings() { return { ...this.config }; }
  saveSettings(input) {
    const config = { enabled: input.enabled === true, start: String(input.start || ''), end: String(input.end || ''), minMinutes: Number(input.minMinutes), maxMinutes: Number(input.maxMinutes), dailyLimit: Number(input.dailyLimit) };
    if (minute(config.start) === null || minute(config.end) === null || config.start === config.end ||
      !Number.isInteger(config.minMinutes) || config.minMinutes < 15 || config.minMinutes > 240 ||
      !Number.isInteger(config.maxMinutes) || config.maxMinutes < config.minMinutes || config.maxMinutes > 360 ||
      !Number.isInteger(config.dailyLimit) || config.dailyLimit < 1 || config.dailyLimit > 12) throw new Error('主动闲聊的时间段或频率无效');
    writeJson(this.configFile, config); this.config = config;
    this.nextAt = this.now() + this.intervalMs(); this.persist();
    return this.settings();
  }
  intervalMs() { const { minMinutes, maxMinutes } = this.config; return Math.round((minMinutes + this.random() * (maxMinutes - minMinutes)) * 60000); }
  inWindow(timestamp) {
    const date = new Date(timestamp), current = date.getHours() * 60 + date.getMinutes();
    const start = minute(this.config.start), end = minute(this.config.end);
    return start < end ? current >= start && current < end : current >= start || current < end;
  }
  // The day a moment belongs to. A day begins at the start of the window, so a
  // window past midnight stays one day with one daily cap.
  dayOf(timestamp) {
    const date = new Date(timestamp);
    if (date.getHours() * 60 + date.getMinutes() < minute(this.config.start)) date.setDate(date.getDate() - 1);
    return date.toLocaleDateString('en-CA');
  }
  userActivity() { this.lastUserAt = this.now(); this.nextAt = Math.max(this.nextAt, this.lastUserAt + 20 * 60000); this.persist(); }
  setPresence(input) { this.presence = { busy: input.busy === true, at: this.now() }; }
  snapshot() {
    return { settings: this.settings(), pomodoro: viewPomodoro(this.pomodoro, this.now()), notices: this.notices.filter(item => item.seq > this.acked) };
  }
  ack(seq) { if (Number.isSafeInteger(seq) && seq > this.acked && seq <= this.sequence) { this.acked = seq; this.notices = this.notices.filter(item => item.seq > seq); this.persist(); } }
  notice(kind, text, conversationId, advance = null) {
    const item = { seq: ++this.sequence, kind, text, conversationId: conversationId || null, createdAt: new Date(this.now()).toISOString(), ...(advance ? { advance } : {}) };
    const previous = this.notices;
    this.notices = [...this.notices, item].slice(-20);
    try { this.persist(); }
    catch (failure) { this.sequence--; this.notices = previous; throw failure; }
    try { this.onNotice(item); } catch {}
    return item;
  }
  // Replaces the plan only once it is saved, so a failed save keeps the previous plan.
  replacePlan(state) {
    const previous = this.pomodoro;
    this.pomodoro = state;
    try { this.persist(); }
    catch (failure) { this.pomodoro = previous; throw failure; }
  }
  // A reminder click stays valid after the notice is acknowledged, but only for its own transition.
  advance(input) {
    const next = advancePomodoro(this.pomodoro, input, this.now());
    if (next) this.replacePlan(next);
    return { ok: true, advanced: !!next, pomodoro: this.snapshot().pomodoro };
  }
  tool(call, conversationId) {
    const result = applyPomodoroCall(this.pomodoro, call, { now: this.now(), conversationId, newId: randomUUID });
    if (!result.ok) return result;
    if (result.state !== this.pomodoro) this.replacePlan(result.state);
    return { ok: true, pomodoro: this.snapshot().pomodoro };
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    const jobs = [];
    try {
      const now = this.now(), upcoming = upcomingExpiry(this.pomodoro), expired = expirePomodoro(this.pomodoro, now, randomUUID);
      if (expired) {
        try { this.replacePlan(expired.state); } catch { return; }
        const { state, reminder } = expired, fallback = FALLBACK[reminder.phase];
        const prepared = this.prepared?.key === upcoming.key ? this.prepared.reply : null;
        this.prepared = null;
        jobs.push((async () => {
          const generated = await prepared || await this.onReminder({ ...state, fallback }).catch(() => null);
          if (this.closed || !reminderApplies(this.pomodoro, reminder)) return;
          const reply = settle(generated);
          this.notice('pomodoro', reply?.text || fallback, reply?.conversationId || state.conversationId, reminderCanAdvance(reminder) ? reminder : null);
        })());
      } else if (upcoming && upcoming.dueAt - now <= PREPARE_MS && this.prepared?.key !== upcoming.key) {
        // Not committed until the phase ends; a plan changed meanwhile has another key, and this reply is dropped.
        this.prepared = { key: upcoming.key, reply: this.onReminder({ ...upcoming.state, fallback: FALLBACK[upcoming.reminder.phase] }).catch(() => null) };
      }
      if (now - this.lastProactiveCheck >= 30000) {
        this.lastProactiveCheck = now;
        if (this.config.enabled && this.inWindow(now) && !holdsProactiveChat(this.pomodoro, now) && this.canProactive() && !this.proactiveJob &&
          !(this.presence.busy && now - this.presence.at < 10000)) {
          const day = this.dayOf(now);
          if (this.day !== day) { this.day = day; this.dailyCount = 0; }
          // An unanswered message is not followed by another until the user replies or a new day begins.
          const unanswered = this.lastProactiveAt > this.lastUserAt && this.dayOf(this.lastProactiveAt) === day;
          if (!this.nextAt || this.nextAt < now - 2 * 3600000) { this.nextAt = now + this.intervalMs(); this.persist(); }
          else if (now >= this.nextAt && this.dailyCount < this.config.dailyLimit && now - this.lastUserAt >= 20 * 60000 && !unanswered && !this.notices.some(item => item.seq > this.acked)) {
            this.nextAt = now + this.intervalMs(); this.dailyCount++; this.proactiveJob = true; this.persist();
            jobs.push((async () => {
              try {
                const generated = await this.onProactive().catch(() => null);
                const reply = !this.closed && !holdsProactiveChat(this.pomodoro, this.now()) ? settle(generated) : null;
                if (reply) { this.lastProactiveAt = this.now(); this.notice('proactive', reply.text, reply.conversationId); }
                else { this.dailyCount--; this.persist(); }
              } finally { this.proactiveJob = false; }
            })());
          }
        }
      }
    } finally { this.busy = false; }
    await Promise.allSettled(jobs);
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}
