import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UsageLedger } from '../runtime/ledger.mjs';
import { browserModule } from './helpers/browser-module.mjs';

const scope = 'abcdefabcdefabcdefabcdef-USD', meterKey = 'a'.repeat(64);

test('the full balance is the highest balance since the last top-up', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-full-balance-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ledger = new UsageLedger(dataDir);
  const full = balance => ledger.observe(scope, { totalBalance: balance, meterKey }).fullBalance;
  assert.equal(full(100), 100, 'the first balance seen is full');
  assert.equal(full(60), 100);
  assert.equal(full(60.5), 100, 'a small rise such as a refund is not a top-up');
  assert.equal(full(40), 100);
  assert.equal(full(90), 90, 'a top-up starts a new full balance even below the old one');
  assert.equal(full(120), 120, 'a balance above the full one becomes full');
  assert.equal(ledger.observe(scope, { totalBalance: 80, meterKey: 'f'.repeat(64) }).fullBalance, 80, 'a different meter starts over');
  assert.equal(ledger.records(scope).fullBalance, 80);
});

const geometry = browserModule('pet-geometry.js');
// A square alpha mask drawn from rows of '#' (opaque) and '.' (clear).
const mask = rows => ({ width: rows[0].length, height: rows.length, alpha: Uint8Array.from(rows.join(''), cell => cell === '#' ? 255 : 0) });

test('the meter spans the bottom edge of the visible pet', () => {
  const edge = rows => JSON.parse(JSON.stringify(geometry.bottomEdge(mask(rows))));
  assert.deepEqual(edge(['..........', '....####..', '...######.', '..#######.', '..#######.']),
    { left: 0.2, right: 0.9, bottom: 1 }, 'the lowest rows, not the box');
  assert.deepEqual(edge(['##########', '##########', '##########', '.......###', '.......###']),
    { left: 0, right: 1, bottom: 1 }, 'a bottom edge under half the pet is too narrow; the pet width is used');
  assert.equal(geometry.bottomEdge(mask(['....', '....'])), null);
});
