(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleBubbleQueue = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // System bubbles: task completions, usage alerts and approval reminders.
  // One shows at a time and interrupts a click bubble. The rest wait by rank
  // (lower first, then arrival); arrivals are batched briefly so rank decides.
  // An approval shows at once, keeps the bubble it interrupted at the front of
  // the queue, and stays until dismissed. Any other bubble closes after its
  // ttlMs, counted from when it is drawn. A bubble that cannot be drawn is
  // skipped; the renderer keeps what was on screen.
  //
  // show(item) draws a bubble and resolves whether it is on screen; hide()
  // closes the last system bubble. Both belong to the caller.
  function create({ show, hide, setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout, batchMs = 30 }) {
    let queue = [], current = null, timer = null, batch = null, epoch = 0;
    const stop = () => { if (timer) cancel(timer); timer = null; };
    function open(item) {
      stop();
      current = item;
      const entry = ++epoch;
      const drawn = committed => {
        if (entry !== epoch) return;
        if (!committed) { current = null; next(); return; }
        if (item.ttlMs > 0) timer = later(() => { timer = null; dismiss(); }, item.ttlMs);
      };
      let shown;
      try { shown = show(item); } catch { shown = false; }
      Promise.resolve(shown).then(drawn, () => drawn(false));
    }
    function next() {
      if (!current && queue.length) open(queue.shift());
    }
    // Ends the bubble on screen, by its time running out or a click.
    function dismiss() {
      if (!current) return false;
      current = null;
      stop();
      if (queue.length) open(queue.shift());
      else { epoch++; hide(); }
      return true;
    }
    function push(item) {
      const rank = item.rank >= 1 ? item.rank : 2, at = queue.findIndex(other => other.rank > rank);
      queue.splice(at < 0 ? queue.length : at, 0, { ...item, rank });
      if (batch) cancel(batch);
      batch = later(() => { batch = null; next(); }, batchMs);
    }
    function approval(item) {
      if (current && current.kind !== 'approval') queue.unshift(current);
      open({ ...item, kind: 'approval', ttlMs: 0 });
    }
    // Drops every bubble, or only those of one kind; one of that kind on screen is dismissed.
    function clear(kind) {
      if (kind) {
        queue = queue.filter(item => item.kind !== kind);
        if (current && current.kind === kind) dismiss();
        return;
      }
      queue = []; current = null; epoch++;
      stop();
      if (batch) cancel(batch);
      batch = null;
    }
    return Object.freeze({ push, approval, dismiss, clear, current: () => current });
  }
  return Object.freeze({ create });
});
