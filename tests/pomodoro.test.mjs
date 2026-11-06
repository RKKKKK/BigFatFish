import assert from 'node:assert/strict';
import test from 'node:test';
import { IDLE, applyPomodoroCall, expirePomodoro, reminderApplies, advancePomodoro, viewPomodoro, pomodoroInProgress, reminderCanAdvance, upcomingExpiry, holdsProactiveChat } from '../runtime/chat/pomodoro.mjs';

const MINUTE = 60000, now = Date.UTC(2026, 8, 30, 2, 0);
const call = (name, args = {}) => ({ name, arguments: JSON.stringify(args) });
let issued = 0;
const newId = () => 'id-' + ++issued;
const expire = (state, at) => expirePomodoro(state, at, newId);
const set = (focusMinutes, breakMinutes, cycles, at = now) => applyPomodoroCall(IDLE, call('pomodoro_set', { focusMinutes, breakMinutes, cycles }), { now: at, conversationId: 'chat_1', newId });
const control = (state, action, at = now, extra = {}) => applyPomodoroCall(state, call('pomodoro_control', { action, ...extra }), { now: at, conversationId: 'chat_1', newId });

test('a plan starts focusing immediately and only within the preauthorized bounds', () => {
  const started = set(25, 5, 2);
  assert.equal(started.ok, true);
  assert.deepEqual({ ...started.state, planId: 'plan' }, { phase: 'focus', planId: 'plan', focusMinutes: 25, breakMinutes: 5, cycles: 2, cycle: 1, dueAt: now + 25 * MINUTE, conversationId: 'chat_1' });
  for (const [focus, rest, cycles] of [[0, 5, 2], [241, 5, 1], [25, 0, 2], [25, 121, 2], [25, 5, 0], [25, 5, 13], [240, 120, 6], [1.5, 5, 2]]) {
    assert.deepEqual(set(focus, rest, cycles), { ok: false, error: '番茄钟数值超出预授权范围' }, `${focus}/${rest}/${cycles}`);
  }
  const refused = { ok: false, error: '此操作不在预授权范围内' };
  assert.deepEqual(applyPomodoroCall(IDLE, call('shell', { command: 'ls' }), { now }), refused);
  assert.deepEqual(applyPomodoroCall(IDLE, { name: 'pomodoro_set', arguments: '{' }, { now }), { ok: false, error: '操作参数格式无效' });
  assert.deepEqual(applyPomodoroCall(IDLE, call('pomodoro_set', { focusMinutes: 25, breakMinutes: 5, cycles: 2, sound: 'loud' }), { now }), { ok: false, error: '番茄钟数值超出预授权范围' });
  assert.deepEqual(applyPomodoroCall(started.state, call('pomodoro_status'), { now }), { ok: true, state: started.state }, 'status reads without changing the plan');
});

test('controls follow the phase table: pause, resume, extend, start break or focus, and stop', () => {
  const focus = set(25, 5, 2).state;
  const paused = control(focus, 'pause', now + 10 * MINUTE).state;
  assert.equal(paused.phase, 'paused'); assert.equal(paused.remainingMs, 15 * MINUTE); assert.equal(paused.dueAt, null);
  assert.deepEqual(control(paused, 'pause'), { ok: false, error: '当前阶段不能执行此操作' });
  const resumed = control(paused, 'resume', now + 60 * MINUTE).state;
  assert.equal(resumed.phase, 'focus'); assert.equal(resumed.dueAt, now + 75 * MINUTE);

  assert.equal(control(focus, 'extend_focus', now, { minutes: 10 }).state.dueAt, now + 35 * MINUTE);
  assert.equal(control(focus, 'extend_focus', now, { minutes: 61 }).ok, false);
  const onBreak = control(focus, 'start_break', now + 20 * MINUTE).state;
  assert.equal(onBreak.phase, 'break'); assert.equal(onBreak.dueAt, now + 25 * MINUTE);
  const second = control(onBreak, 'start_focus', now + 22 * MINUTE).state;
  assert.equal(second.cycle, 2); assert.equal(second.dueAt, now + 47 * MINUTE);
  assert.equal(control(second, 'start_break').ok, false, 'the last cycle has no break');
  assert.equal(control(second, 'start_focus').ok, false);
  assert.deepEqual(control(second, 'stop').state, IDLE);
  assert.equal(control(IDLE, 'stop').ok, false);
  assert.equal(control(focus, 'restart').ok, false);
});

test('a finished phase waits for the user with a reminder that can advance only its own transition', () => {
  const focus = set(1, 1, 2).state;
  assert.equal(expire(focus, now + MINUTE - 1), null);
  const { state: waiting, reminder } = expire(focus, now + MINUTE);
  assert.equal(waiting.phase, 'await_break'); assert.equal(waiting.dueAt, null);
  assert.deepEqual(reminder, { planId: focus.planId, reminderId: waiting.reminderId, phase: 'await_break', cycle: 1 });
  assert.equal(expire(waiting, now + 10 * MINUTE), null, 'a waiting phase never expires on its own');
  assert.equal(reminderApplies(waiting, reminder), true);

  const onBreak = advancePomodoro(waiting, reminder, now + 2 * MINUTE);
  assert.equal(onBreak.phase, 'break'); assert.equal(onBreak.dueAt, now + 3 * MINUTE);
  assert.equal(advancePomodoro(onBreak, reminder, now), null, 'a second click does nothing');

  const extended = control(waiting, 'extend_focus', now + MINUTE, { minutes: 1 }).state;
  const { state: again, reminder: later } = expire(extended, now + 2 * MINUTE);
  assert.equal(advancePomodoro(again, reminder, now), null, 'the reminder from before the extension has expired');
  for (const forged of [{ ...later, cycle: 2 }, { ...later, action: 'stop' }, { ...later, reminderId: '' }, null, 'later']) {
    assert.equal(advancePomodoro(again, forged, now), null);
  }
  const replaced = expire(set(1, 1, 2, now + 2 * MINUTE).state, now + 3 * MINUTE).state;
  assert.equal(advancePomodoro(replaced, later, now), null, 'a replaced plan ignores the old reminder');
  assert.equal(reminderApplies(replaced, later), false);

  const breakOver = expire(onBreak, now + 3 * MINUTE), repeated = expire(onBreak, now + 3 * MINUTE);
  assert.equal(advancePomodoro(breakOver.state, repeated.reminder, now), null, 'a reminder applies only to the expiry that issued it');
  assert.deepEqual(expirePomodoro(onBreak, now + 3 * MINUTE, () => 'same'), expirePomodoro(onBreak, now + 3 * MINUTE, () => 'same'), 'the same values give the same result');
  assert.equal(breakOver.state.phase, 'await_focus');
  const lastFocus = advancePomodoro(breakOver.state, breakOver.reminder, now + 4 * MINUTE);
  assert.equal(lastFocus.cycle, 2);
  const done = expire(lastFocus, now + 5 * MINUTE);
  assert.equal(done.state.phase, 'completed'); assert.equal(done.reminder.phase, 'completed');
  assert.equal(advancePomodoro(done.state, done.reminder, now), null, 'completion has no next phase');
  assert.deepEqual([reminder, breakOver.reminder, done.reminder].map(reminderCanAdvance), [true, true, false]);
});

test('a plan is in progress from its start until it completes or stops', () => {
  const focus = set(1, 1, 1).state, done = expire(focus, now + MINUTE).state;
  assert.deepEqual([IDLE, focus, control(focus, 'pause').state, done, control(focus, 'stop').state].map(pomodoroInProgress), [false, true, true, false, false]);
});

test('a running phase keeps proactive chat quiet; a plan left waiting or paused does so for an hour at most', () => {
  const focus = set(25, 5, 2).state, end = focus.dueAt;
  const waiting = expire(focus, end).state, paused = control(focus, 'pause', now + 10 * MINUTE).state;
  assert.equal(holdsProactiveChat(focus, end - MINUTE), true);
  assert.equal(holdsProactiveChat(waiting, end + 59 * MINUTE), true);
  assert.equal(holdsProactiveChat(waiting, end + 61 * MINUTE), false, 'a reminder left unanswered for an hour no longer keeps the character quiet');
  assert.equal(holdsProactiveChat(paused, now + 69 * MINUTE), true);
  assert.equal(holdsProactiveChat(paused, now + 71 * MINUTE), false);
  assert.equal(holdsProactiveChat(control(paused, 'resume', now + 120 * MINUTE).state, now + 125 * MINUTE), true, 'resuming runs a phase again');
  const onBreak = control(waiting, 'start_break', end + 90 * MINUTE).state;
  assert.equal(holdsProactiveChat(onBreak, end + 92 * MINUTE), true);
  assert.equal(holdsProactiveChat(expire(onBreak, onBreak.dueAt).state, onBreak.dueAt + 10 * MINUTE), true, 'the next waiting phase starts its own hour');
  assert.equal(holdsProactiveChat(IDLE, now), false);
  assert.equal(holdsProactiveChat(expire(set(1, 1, 1).state, now + MINUTE).state, now + MINUTE), false, 'a completed plan never does');
  assert.equal(holdsProactiveChat({ ...waiting, waitingSince: undefined }, end), false, 'a plan saved waiting before this rule does not');
});

test('the view reports the remaining time from the runtime clock', () => {
  const focus = set(25, 5, 2).state;
  assert.equal(viewPomodoro(focus, now + 61000).remainingSeconds, 24 * 60 - 1);
  assert.equal(viewPomodoro(focus, now + 26 * MINUTE).remainingSeconds, 0);
  assert.equal(viewPomodoro(control(focus, 'pause', now + 5 * MINUTE).state, now + 99 * MINUTE).remainingSeconds, 20 * 60);
  assert.equal(viewPomodoro(IDLE, now).remainingSeconds, undefined);
  assert.notEqual(viewPomodoro(focus, now), focus, 'the view is a copy');
});

test('a running phase knows the expiry it is heading for, under a key that changes with the plan', () => {
  const focus = set(25, 5, 2).state, upcoming = upcomingExpiry(focus);
  assert.equal(upcoming.dueAt, focus.dueAt); assert.equal(upcoming.state.phase, 'await_break'); assert.equal(upcoming.reminder.cycle, 1);
  assert.equal(upcomingExpiry(focus).key, upcoming.key, 'an unchanged plan keeps its key');
  const paused = control(focus, 'pause').state;
  assert.equal(upcomingExpiry(paused), null, 'nothing is heading for an expiry while paused');
  const changed = [control(focus, 'extend_focus', now, { minutes: 5 }).state, control(paused, 'resume', now + MINUTE).state, control(focus, 'start_break').state, set(25, 5, 2).state];
  assert.equal(new Set([focus, ...changed].map(state => upcomingExpiry(state).key)).size, 5);
});
