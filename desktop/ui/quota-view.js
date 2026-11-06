// The quota under the pet: the current account's name and bars, and behind
// its ▾ an overview of every account. It shows what the quota book says;
// choosing an account goes back to the book.
export function createQuotaView({ root, pet, presentation, money, rendering, geometry, select, openManager, now = Date.now }) {
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text, action) => {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', event => { event.stopPropagation(); action(); });
    return node;
  };
  const box = element('div', 'dshwv-meter'), head = button('dshwv-meter-head', undefined, () => panel.hidden ? open() : close());
  const name = element('span', 'dshwv-meter-name'), bars = element('div', 'dshwv-meter-bars');
  head.setAttribute('aria-expanded', 'false');
  head.append(name, element('span', 'dshwv-meter-caret', '▾'));
  box.hidden = true;
  box.append(head, bars);
  root.querySelector('.dshwv-body').append(box);
  const panel = element('section', 'quota-overview');
  panel.hidden = true;
  panel.setAttribute('aria-label', '全部额度');
  document.body.append(panel);
  const edges = new WeakMap();
  let snapshot = null, barsKey = '';
  const format = money.formatMoney;

  function meterRow(meter) {
    const row = element('div', 'dshwv-meter-row dshwv-meter-' + meter.level), track = element('div', 'dshwv-meter-track');
    const fill = element('div', 'dshwv-meter-fill');
    fill.style.width = meter.percent + '%';
    track.append(fill);
    row.append(element('span', '', meter.label), track);
    if (meter.value) row.append(element('span', 'dshwv-meter-value', meter.value));
    return row;
  }
  function renderMeter() {
    const account = presentation.current(snapshot);
    box.hidden = !account;
    if (!account) { close(); return; }
    name.textContent = account.name;
    head.title = presentation.title(account) + ' · 查看全部额度';
    head.setAttribute('aria-label', presentation.title(account) + '，查看全部额度');
    // A subscription shows the share left; an API account, the money left.
    const meters = presentation.meters(account, { formatMoney: format }), key = JSON.stringify(meters);
    if (key !== barsKey) { barsKey = key; bars.replaceChildren(...meters.map(meterRow)); }
    place();
  }
  // Where the visible pet ends, from its alpha mask; null until the mask is decoded.
  function bottomEdge() {
    const mask = rendering.hitCache.maskOf(pet);
    if (!mask) return null;
    if (!edges.has(mask)) edges.set(mask, geometry.bottomEdge(mask));
    return edges.get(mask);
  }
  // As wide as the pet's bottom edge and just under it, in whole pixels so text
  // stays sharp; inside the bottom of the pet when the screen edge leaves no room.
  function place() {
    if (box.hidden) return;
    const size = root.offsetWidth || 0;
    if (!size) return;
    const art = size * 0.5945, start = size - art, edge = bottomEdge() || { left: 0, right: 1, bottom: 1 };
    const left = Math.round(start + edge.left * art), right = Math.round(start + edge.right * art), bottom = Math.round(start + edge.bottom * art);
    box.style.fontSize = Math.max(9, Math.min(13, Math.round(size * 0.05))) + 'px';
    box.style.setProperty('--dshw-meter-bar', Math.max(4, Math.min(8, Math.round(size * 0.025))) + 'px');
    box.style.left = left + 'px';
    box.style.width = Math.max(48, right - left) + 'px';
    const height = box.offsetHeight, top = root.getBoundingClientRect().top;
    box.style.top = (top + bottom + 3 + height <= window.innerHeight ? bottom + 3 : bottom - height - 3) + 'px';
    if (!panel.hidden) placePanel();
    rendering.presentFor(200);
  }

  function overviewRow(item) {
    const row = element('div', 'quota-row quota-row-' + item.level);
    row.append(element('span', 'quota-row-label', item.label));
    if (item.percent === null) row.append(element('span'));
    else {
      const track = element('div', 'quota-row-track'), fill = element('div', 'quota-row-fill');
      fill.style.width = item.percent + '%';
      track.append(fill);
      row.append(track);
    }
    row.append(element('span', 'quota-row-value', item.value), element('span', 'quota-row-note', item.note));
    return row;
  }
  function renderPanel() {
    const time = now();
    const header = element('header', 'quota-overview-head');
    header.append(element('strong', '', '全部额度'), button('', '×', close));
    header.lastChild.setAttribute('aria-label', '收起');
    const cards = presentation.overview(snapshot).map(account => {
      const card = element('div', 'quota-account'), top = element('div', 'quota-account-top');
      card.dataset.accountId = account.id;
      top.append(element('strong', '', presentation.title(account)));
      if (account.id === snapshot.current) top.append(element('span', 'quota-current', '当前'));
      else if (account.available) top.append(button('quota-select', '设为当前', () => choose(account.id)));
      card.append(top, ...presentation.rows(account, { formatMoney: format, now: time }).map(overviewRow));
      const pace = presentation.paceText(account, { formatMoney: format, now: time }), status = presentation.status(account);
      if (pace) card.append(element('p', 'quota-pace', pace));
      if (status) card.append(element('p', 'quota-status', status));
      return card;
    });
    const footer = element('footer', 'quota-overview-foot');
    footer.append(button('quota-manage', '额度管理…', () => { close(); openManager(); }));
    panel.replaceChildren(header, ...cards, footer);
  }
  // Beside the pet where it fits, else above or below it.
  function placePanel() {
    const image = pet.getBoundingClientRect(), meter = box.getBoundingClientRect();
    const bounds = { left: Math.min(image.left, meter.left), top: Math.min(image.top, meter.top), right: Math.max(image.right, meter.right), bottom: Math.max(image.bottom, meter.bottom) };
    const width = panel.offsetWidth, height = panel.offsetHeight, viewWidth = window.innerWidth, viewHeight = window.innerHeight;
    const center = (bounds.left + bounds.right) / 2;
    const candidates = [
      { left: bounds.left - width - 10, top: bounds.bottom - height },
      { left: bounds.right + 10, top: bounds.bottom - height },
      { left: center - width / 2, top: bounds.top - height - 10 },
      { left: center - width / 2, top: bounds.bottom + 10 },
    ];
    const fits = point => point.left >= 8 && point.top >= 8 && point.left + width <= viewWidth - 8 && point.top + height <= viewHeight - 8;
    const chosen = candidates.find(fits) || candidates[0];
    panel.style.left = Math.max(8, Math.min(chosen.left, viewWidth - width - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(chosen.top, viewHeight - height - 8)) + 'px';
  }
  function open() {
    if (!snapshot) return;
    renderPanel();
    panel.hidden = false;
    head.setAttribute('aria-expanded', 'true');
    placePanel();
    rendering.presentFor(200);
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    head.setAttribute('aria-expanded', 'false');
    rendering.presentFor(200);
  }
  async function choose(id) {
    try { await select(id); }
    catch (error) { window.whaleToast?.(error?.message || '切换未完成，请重试'); }
    window.dispatchEvent(new Event('whale-quotas-changed'));
  }
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target) && !head.contains(event.target)) close();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  money.onChange(() => {
    renderMeter();
    if (!panel.hidden) { renderPanel(); placePanel(); }
  });

  return Object.freeze({
    update(next) {
      snapshot = next && Array.isArray(next.accounts) ? next : null;
      renderMeter();
      if (!panel.hidden) { renderPanel(); placePanel(); }
    },
    place, open, close,
  });
}
