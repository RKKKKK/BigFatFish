(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhalePetGeometry = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // The visible bottom edge of the pet in its square image box, as fractions of
  // the box: the opaque extent of its lowest rows, or the whole pet's width when
  // that is under half of it. The mask is the hit cache's, drawn like the image:
  // contained in the square and aligned right and bottom. Null when nothing shows.
  function bottomEdge({ width, height, alpha }) {
    const opaque = (x, y) => alpha[y * width + x] > 10;
    let top = -1, bottom = -1, left = width, right = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!opaque(x, y)) continue;
        if (top < 0) top = y;
        bottom = y; left = Math.min(left, x); right = Math.max(right, x);
      }
    }
    if (bottom < 0) return null;
    let bandLeft = width, bandRight = -1;
    for (let y = Math.max(top, bottom - Math.max(1, Math.round((bottom - top) * 0.08))); y <= bottom; y++) {
      for (let x = 0; x < width; x++) if (opaque(x, y)) { bandLeft = Math.min(bandLeft, x); bandRight = Math.max(bandRight, x); }
    }
    const narrow = bandRight - bandLeft < (right - left) / 2;
    return { left: (narrow ? left : bandLeft) / width, right: ((narrow ? right : bandRight) + 1) / width, bottom: (bottom + 1) / height };
  }
  return Object.freeze({ bottomEdge });
});
