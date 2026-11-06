// How long quota lasts at the rate it is being used. Plain arithmetic over
// what the quota book already knows; nothing here reads files or the clock.
const MINUTE = 60000, DAY = 24 * 60 * MINUTE;
const time = value => typeof value === 'number' ? value : Date.parse(value);
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// A subscription window used at its average rate so far: the share it will
// have used when it resets, and when it runs out if that comes first. Early
// in a window the rate says little, so there is no pace yet.
export function windowPace({ usedPercent, windowMinutes, resetsAt, observedAt }) {
  const length = windowMinutes * MINUTE, elapsed = length - (time(resetsAt) - observedAt);
  if (!Number.isFinite(elapsed) || elapsed < Math.max(length * 0.1, 15 * MINUTE) || elapsed > length || !amount(usedPercent)) return null;
  const projectedPercent = usedPercent * length / elapsed;
  if (projectedPercent < 100) return { projectedPercent: Math.round(projectedPercent), exhaustAt: null };
  return { projectedPercent: Math.round(projectedPercent), exhaustAt: Math.round(observedAt + (100 - usedPercent) / usedPercent * elapsed) };
}

// The daily spend that sets the pace for money: the average over the recent
// full days whose total is known.
export function dailyAverage(days) {
  const known = days.map(day => day?.total).filter(amount);
  return known.length ? { amount: known.reduce((sum, total) => sum + total, 0) / known.length, days: known.length } : null;
}

// A money quota that resets: whether it lasts until the reset at the average
// daily spend, and when it runs out if not.
export function limitPace({ remaining, resetsAt, average, now }) {
  if (!average || !amount(remaining)) return null;
  if (!(average.amount > 0)) return { enough: true, exhaustAt: null };
  const exhaustAt = Math.round(now + remaining / average.amount * DAY);
  return exhaustAt >= time(resetsAt) ? { enough: true, exhaustAt: null } : { enough: false, exhaustAt };
}

// A balance that never resets: how many days it lasts at the average daily spend.
export function balancePace({ amount: balance, average }) {
  if (!average || !(average.amount > 0) || !amount(balance)) return null;
  return { daysLeft: balance / average.amount };
}
