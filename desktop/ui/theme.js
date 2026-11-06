// The color theme: 海盐汽水, 深海夜光 or 女仆墨蓝. Loaded before the page paints,
// so the first frame already wears the chosen colors. The choice is kept as
// dshw-theme in localStorage, which the desktop saves with the rest of ui-state.
(() => {
  'use strict';
  const THEMES = Object.freeze([
    Object.freeze({ id: 'soda', name: '海盐汽水' }),
    Object.freeze({ id: 'abyss', name: '深海夜光' }),
    Object.freeze({ id: 'lace', name: '女仆墨蓝' }),
  ]);
  const KEY = 'dshw-theme';
  const known = id => THEMES.some(theme => theme.id === id);
  let current = THEMES[0].id;
  try { const saved = localStorage.getItem(KEY); if (known(saved)) current = saved; } catch {}
  document.documentElement.dataset.theme = current;
  function set(id) {
    if (!known(id) || id === current) return current;
    current = id;
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem(KEY, id); } catch {}
    window.dispatchEvent(new CustomEvent('whale-theme', { detail: { theme: id } }));
    return id;
  }
  window.WhaleTheme = Object.freeze({ themes: THEMES, current: () => current, set });
})();
