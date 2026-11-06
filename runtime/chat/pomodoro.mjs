// The Pomodoro plan as plain values: every rule about phases, limits and
// reminder identity lives here. Callers own persistence, clocks, new ids and notices.
// Phases: focus → await_break → break → await_focus → focus … → completed;
// focus and break may be paused. Waiting phases never expire on their own.

export const IDLE = Object.freeze({ phase: 'idle' });

export const POMODORO_TOOLS = Object.freeze([
  { type: 'function', function: { name: 'pomodoro_set', description: 'Set and immediately start one Pomodoro plan. Use only when the user asks to set or replace a timer. You may adapt the requested durations within reasonable bounds; tell the user the actual plan.', parameters: { type: 'object', properties: { focusMinutes: { type: 'integer', minimum: 1, maximum: 240 }, breakMinutes: { type: 'integer', minimum: 1, maximum: 120 }, cycles: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['focusMinutes', 'breakMinutes', 'cycles'], additionalProperties: false } } },
  { type: 'function', function: { name: 'pomodoro_control', description: 'Control the current Pomodoro. Use only when the user asks or answers a phase reminder.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume', 'start_break', 'start_focus', 'extend_focus', 'stop'] }, minutes: { type: 'integer', minimum: 1, maximum: 60 } }, required: ['action'], additionalProperties: false } } },
  { type: 'function', function: { name: 'pomodoro_status', description: 'Read the current Pomodoro state when needed to answer the user.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
]);
export const POMODORO_POLICY = '番茄钟工具已经预授权，会在本地立即执行。仅用于用户请求设置或控制计时、回应计时提醒；日常闲聊不要调用。可偶尔按情况建议合理的专注与休息时长，或询问缺失的信息。深夜请求开始番茄钟时，可以依人设先劝休息、建议缩短，或询问用户是否仍想继续；选择先询问时不要调用设置工具，用户明确坚持后可以执行。调用成功后说明实际安排；调用失败不要宣称已执行。';

const REMINDER_KEYS = ['planId', 'reminderId', 'phase', 'cycle'];
const refuse = error => ({ ok: false, error });
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const between = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const ADVANCING = ['await_break', 'await_focus'];
const HOUR = 60 * 60000;

// Whether a plan is under way, from its start until it completes or stops.
export const pomodoroInProgress = state => !['idle', 'completed'].includes(state.phase);
// Whether the plan keeps proactive chat quiet: a running phase does, and a plan
// waiting for the user, after a reminder or a pause, does for an hour at most.
export function holdsProactiveChat(state, now) {
  if (['focus', 'break'].includes(state.phase)) return true;
  return ['await_break', 'await_focus', 'paused'].includes(state.phase) && now - state.waitingSince < HOUR;
}
// Whether clicking the reminder starts the next phase; the completion reminder has none.
export const reminderCanAdvance = reminder => ADVANCING.includes(reminder?.phase);

// Applies one preauthorized tool call. Refusals are returned to the model; they never throw.
// A new plan takes its id from newId().
export function applyPomodoroCall(state, call, { now, conversationId = null, newId }) {
  if (!call || typeof call !== 'object' || !POMODORO_TOOLS.some(tool => tool.function.name === call.name) || typeof call.arguments !== 'string' || call.arguments.length > 4096) return refuse('此操作不在预授权范围内');
  let args;
  try { args = JSON.parse(call.arguments); } catch { return refuse('操作参数格式无效'); }
  if (call.name === 'pomodoro_status') return own(args, []) ? { ok: true, state } : refuse('操作参数格式无效');
  if (call.name === 'pomodoro_set') {
    const { focusMinutes, breakMinutes, cycles } = args || {};
    if (!own(args, ['focusMinutes', 'breakMinutes', 'cycles']) || !between(focusMinutes, 1, 240) || !between(breakMinutes, 1, 120) || !between(cycles, 1, 12) ||
      focusMinutes * cycles + breakMinutes * (cycles - 1) > 24 * 60) return refuse('番茄钟数值超出预授权范围');
    return { ok: true, state: { phase: 'focus', planId: newId(), focusMinutes, breakMinutes, cycles, cycle: 1, dueAt: now + focusMinutes * 60000, conversationId } };
  }
  if (!own(args, ['action', 'minutes']) || !['pause', 'resume', 'start_break', 'start_focus', 'extend_focus', 'stop'].includes(args.action)) return refuse('此操作不在预授权范围内');
  const { action, minutes } = args, { phase } = state;
  if (action === 'pause' && ['focus', 'break'].includes(phase)) return { ok: true, state: { ...state, phase: 'paused', pausedFrom: phase, remainingMs: Math.max(0, state.dueAt - now), dueAt: null, waitingSince: now } };
  if (action === 'resume' && phase === 'paused') return { ok: true, state: { ...state, phase: state.pausedFrom, dueAt: now + state.remainingMs, pausedFrom: null, remainingMs: null, waitingSince: null } };
  if (action === 'start_break' && ['focus', 'await_break'].includes(phase) && state.cycle < state.cycles) return { ok: true, state: { ...state, phase: 'break', dueAt: now + state.breakMinutes * 60000, waitingSince: null } };
  if (action === 'start_focus' && ['break', 'await_focus'].includes(phase) && state.cycle < state.cycles) return { ok: true, state: { ...state, phase: 'focus', cycle: state.cycle + 1, dueAt: now + state.focusMinutes * 60000, waitingSince: null } };
  if (action === 'extend_focus' && ['focus', 'await_break'].includes(phase) && between(minutes, 1, 60)) return { ok: true, state: { ...state, phase: 'focus', dueAt: Math.max(now, state.dueAt || now) + minutes * 60000, waitingSince: null } };
  if (action === 'stop' && pomodoroInProgress(state)) return { ok: true, state: IDLE };
  return refuse('当前阶段不能执行此操作');
}

// When focus or break has run out: the waiting state, and the reminder that may advance it.
// Each expiry takes a new reminder identity from newId(), so reminders for earlier phases stop applying.
export function expirePomodoro(state, now, newId) {
  if (!['focus', 'break'].includes(state.phase) || now < state.dueAt) return null;
  const phase = state.phase === 'break' ? 'await_focus' : state.cycle === state.cycles ? 'completed' : 'await_break';
  const next = { ...state, phase, dueAt: null, reminderId: newId(), waitingSince: now };
  return { state: next, reminder: Object.fromEntries(REMINDER_KEYS.map(key => [key, next[key]])) };
}

// The expiry a running phase is heading for: the waiting state and reminder it will
// bring, under a key that changes with any change to the plan (pause, extension, an
// early break, stop, a new plan). Null when no phase is running.
export function upcomingExpiry(state) {
  if (!['focus', 'break'].includes(state.phase)) return null;
  return { key: [state.planId, state.cycle, state.phase, state.dueAt].join(':'), dueAt: state.dueAt, ...expirePomodoro(state, state.dueAt, () => null) };
}

// Whether a reminder still describes the current waiting phase of the current plan.
export function reminderApplies(state, reminder) {
  return !!own(reminder, REMINDER_KEYS) && !!reminder.reminderId && REMINDER_KEYS.every(key => reminder[key] === state[key]);
}

// A reminder click starts the phase it announced, once; anything else is ignored.
export function advancePomodoro(state, reminder, now) {
  if (!ADVANCING.includes(state.phase) || !reminderApplies(state, reminder)) return null;
  const result = applyPomodoroCall(state, { name: 'pomodoro_control', arguments: JSON.stringify({ action: state.phase === 'await_break' ? 'start_break' : 'start_focus' }) }, { now });
  return result.ok ? result.state : null;
}

export function viewPomodoro(state, now) {
  const view = { ...state };
  if (['focus', 'break'].includes(state.phase)) view.remainingSeconds = Math.max(0, Math.ceil((state.dueAt - now) / 1000));
  if (state.phase === 'paused') view.remainingSeconds = Math.max(0, Math.ceil(state.remainingMs / 1000));
  return view;
}
