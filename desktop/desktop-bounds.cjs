const validArea = area => area && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(area[key])) && area.width > 10 && area.height > 10;

function desktopArea(screen) {
  const areas = screen.getAllDisplays().map(display => display.workArea).filter(validArea);
  if (!areas.length) {
    const fallback = screen.getPrimaryDisplay()?.workArea;
    return validArea(fallback) ? fallback : null;
  }
  const left = Math.min(...areas.map(area => area.x));
  const top = Math.min(...areas.map(area => area.y));
  const right = Math.max(...areas.map(area => area.x + area.width));
  const bottom = Math.max(...areas.map(area => area.y + area.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function desktopBoundsSync(screen, window) {
  let applied = JSON.stringify(window.getBounds());
  return () => {
    if (window.isDestroyed()) return false;
    const target = desktopArea(screen);
    if (!target) return false;
    const key = JSON.stringify(target);
    const current = window.getBounds();
    const settled = ['x', 'y', 'width', 'height'].every(axis => Math.abs(current[axis] - target[axis]) <= 1);
    if (key === applied && settled) return false;
    window.setBounds(target);
    applied = key;
    return true;
  };
}

module.exports = { desktopArea, desktopBoundsSync };
