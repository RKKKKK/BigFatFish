(() => {
  'use strict';
  // A short message at the top of the page, for results nothing else shows.
  let timer;
  window.whaleToast = message => {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = String(message || '');
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { toast.hidden = true; }, 6000);
  };
})();
