import { createQuotaView } from './quota-view.js';
import { createQuotaManager } from './quota-manager.js';

async function request(url, method = 'GET', body) {
  const response = await fetch(url, { method, cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '操作未完成，请重试');
  return result;
}
const manager = createQuotaManager({ dialog: document.getElementById('quota-manager'), request, money: window.WhaleMoney, presentation: window.WhaleQuotaPresentation,
  toast: message => window.whaleToast?.(message), onChanged: () => window.dispatchEvent(new Event('whale-quotas-changed')) });
window.addEventListener('whale-open-settings', event => { void manager.open({ tab: event.detail?.tab }); });

// The widget fetches the quota book and announces each snapshot; this view
// draws it under the pet. A choice made here goes straight to the book.
const root = document.querySelector('.dshwv-root');
if (root) {
  const view = createQuotaView({ root, pet: root.querySelector('.dshwv-img'), presentation: window.WhaleQuotaPresentation, money: window.WhaleMoney,
    rendering: window.WhaleRendering, geometry: window.WhalePetGeometry,
    select: id => request('/api/quotas/current', 'PUT', { id }),
    openManager: () => { void manager.open(); } });
  window.addEventListener('whale-quotas', event => view.update(event.detail));
  window.addEventListener('whale-pet-layout', () => view.place());
  window.dispatchEvent(new Event('whale-quotas-request'));
  if (window.whaleDesktop?.testMode) window.__whaleQuotaTest = Object.freeze({ open: view.open, close: view.close });
}
