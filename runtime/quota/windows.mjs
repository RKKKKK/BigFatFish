// The one rule for subscription quota windows, whichever product reports them:
// a window shows its used share until it resets, each window expires on its
// own, and an account has quota to show while any of its windows is valid.
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export const WINDOW_MINUTES = Object.freeze({ fiveHour: 300, sevenDay: 10080 });

// A stored window: the share used (0–100), its length and when it resets.
export function storedWindow(value, windowMinutes) {
  const usedPercent = finite(value?.usedPercent), resetsAt = finite(value?.resetsAt);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100 || resetsAt === null || resetsAt <= 0 ||
    value.windowMinutes !== undefined && value.windowMinutes !== windowMinutes) return null;
  return { usedPercent, windowMinutes, resetsAt };
}

// The window as shown, or null once it has reset: an old share says nothing
// about the new window.
export function publicWindow(value, windowMinutes, now = Date.now()) {
  const window = storedWindow(value, windowMinutes);
  if (!window || window.resetsAt <= now) return null;
  return { usedPercent: window.usedPercent, remainingPercent: 100 - window.usedPercent, windowMinutes,
    resetsAt: new Date(window.resetsAt).toISOString() };
}

export function publicWindows(snapshot, now = Date.now()) {
  const fiveHour = publicWindow(snapshot?.fiveHour, WINDOW_MINUTES.fiveHour, now);
  const sevenDay = publicWindow(snapshot?.sevenDay, WINDOW_MINUTES.sevenDay, now);
  return { available: !!(fiveHour || sevenDay), fiveHour, sevenDay };
}

// A Codex snapshot as the runtime stores it. Codex reports both windows in
// every snapshot, so one without both is not a Codex snapshot. No account data
// is kept.
export function codexSnapshot(value) {
  const observedAt = finite(value?.observedAt);
  const fiveHour = storedWindow(value?.fiveHour, WINDOW_MINUTES.fiveHour), sevenDay = storedWindow(value?.sevenDay, WINDOW_MINUTES.sevenDay);
  if (observedAt === null || !fiveHour || !sevenDay) return null;
  return { source: 'codex-session-rate-limits', observedAt,
    planType: typeof value.planType === 'string' ? value.planType.slice(0, 64) : '', fiveHour, sevenDay };
}

// A Codex snapshot as shown, or null when no window is valid any more.
export function publicCodexSnapshot(value, now = Date.now()) {
  const snapshot = codexSnapshot(value);
  if (!snapshot) return null;
  const windows = publicWindows(snapshot, now);
  return windows.available ? { planType: snapshot.planType, observedAt: new Date(snapshot.observedAt).toISOString(),
    fiveHour: windows.fiveHour, sevenDay: windows.sevenDay } : null;
}
