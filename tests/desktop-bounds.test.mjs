import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { desktopArea, desktopBoundsSync } = require('../desktop/desktop-bounds.cjs');

const laptop = { x: 0, y: 0, width: 1512, height: 948 };
const external = { x: -1920, y: -120, width: 1920, height: 1080 };
let displays = [{ workArea: laptop }, { workArea: external }];
const screen = { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] };
const initial = { x: -1920, y: -120, width: 3432, height: 1080 };
assert.deepEqual(desktopArea(screen), initial);

let bounds = { ...initial }, updates = 0;
const window = { getBounds: () => ({ ...bounds }), setBounds: next => { bounds = { ...next }; updates++; }, isDestroyed: () => false };
const sync = desktopBoundsSync(screen, window);
assert.equal(sync(), false);

displays = [{ workArea: laptop }];
assert.equal(sync(), true);
assert.deepEqual(bounds, laptop);
assert.equal(sync(), false);

displays = [{ workArea: { x: 0, y: 0, width: 1280, height: 720 } }];
assert.equal(sync(), true);
assert.deepEqual(bounds, displays[0].workArea);

bounds.x = 5000;
assert.equal(sync(), true);
assert.equal(bounds.x, 0);
assert.equal(updates, 3);

console.log('desktop bounds follow display removal, resolution changes and native window drift');
