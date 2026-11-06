import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { captureClaudeUsage, claudeSubscription, saveClaudeUsage } from '../runtime/claude-usage.mjs';
import { configureClaudeStatusline } from '../scripts/configure-claude-statusline.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';
import { bridgeRequest, startBridge } from '../runtime/bridge.mjs';
import { claudeIntegrationStatus } from '../runtime/claude-integration.mjs';
import { CLAUDE_TRACKED_EVENTS } from '../runtime/agents/claude-hooks.mjs';

const sample = now => ({ session_id: 'private-session', transcript_path: '/private/chat.jsonl',
  model: { display_name: 'Sonnet' }, rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: Math.floor(now / 1000) + 3600 },
    seven_day: { used_percentage: 41.2, resets_at: Math.floor(now / 1000) + 86400 }
  }, message: { content: 'private conversation' } });

test('status line capture keeps only Claude quota fields and the local route handles partial or expired windows', async t => {
  const dataDir = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'wc-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = Date.now(), input = sample(now);
  assert.equal(saveClaudeUsage(dataDir, input, now), true);
  const saved = fs.readFileSync(path.join(dataDir, 'claude-subscription.json'), 'utf8');
  assert.ok(!saved.includes('private'));
  assert.ok(!saved.includes('Sonnet'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'claude-subscription.json')).mode & 0o777, 0o600);
  const result = claudeSubscription(dataDir, now);
  assert.equal(result.provider, 'Claude');
  assert.equal(result.fiveHour.remainingPercent, 76.5);
  assert.equal(result.sevenDay.remainingPercent, 58.8);
  assert.equal(Date.parse(result.fiveHour.resetsAt), input.rate_limits.five_hour.resets_at * 1000);
  assert.equal(claudeSubscription(dataDir, now + 3600000).fiveHour, null);
  assert.equal(claudeSubscription(dataDir, now + 3600000).available, true);
  assert.equal(claudeSubscription(dataDir, now + 86400000).available, false);
  const dispatcher = createDispatcher({ dataDir, monitor: false, autoRefresh: false });
  t.after(() => dispatcher.close());
  const route = JSON.parse((await dispatcher.dispatch('/api/claude/subscription')).body);
  assert.equal(route.provider, 'Claude');
  assert.equal(route.fiveHour.remainingPercent, 76.5);
  assert.equal(JSON.stringify(route).includes('private'), false);
  const bridge = await startBridge(dispatcher, { dataDir });
  t.after(() => bridge.close());
  const bridged = await bridgeRequest('/api/claude/subscription', { dataDir });
  assert.equal(bridged.fiveHour.remainingPercent, 76.5);
});

test('invalid or absent rate-limit windows never become zero usage or replace Codex data', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-claude-missing-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = Date.now();
  assert.equal(claudeSubscription(dataDir, now).available, false);
  assert.equal(captureClaudeUsage({ rate_limits: { five_hour: { used_percentage: 101, resets_at: now / 1000 + 3600 } } }, now).fiveHour, null);
  assert.equal(saveClaudeUsage(dataDir, { rate_limits: {} }, now), false, 'a push without quota saves nothing');
  assert.equal(claudeSubscription(dataDir, now).available, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'subscription-rate-limits.json')), false);
});

test('a push without quota keeps the windows already known', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-claude-keep-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = Date.now();
  saveClaudeUsage(dataDir, sample(now), now);
  assert.equal(saveClaudeUsage(dataDir, { session_id: 'private-session', rate_limits: {} }, now + 1000), false);
  assert.equal(claudeSubscription(dataDir, now + 1000).fiveHour.remainingPercent, 76.5);
  saveClaudeUsage(dataDir, { rate_limits: { five_hour: { used_percentage: 50, resets_at: Math.floor(now / 1000) + 7200 } } }, now + 2000);
  const result = claudeSubscription(dataDir, now + 2000);
  assert.equal(result.fiveHour.remainingPercent, 50, 'a reported window replaces the old one');
  assert.equal(result.sevenDay.remainingPercent, 58.8, 'a window left out keeps its last value until it resets');
  assert.equal(result.observedAt, new Date(now + 2000).toISOString());
});

test('collector accepts official stdin JSON without saving message content', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-claude-cli-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/claude-statusline.mjs', '--data-dir', dataDir], {
    input: JSON.stringify(sample(Date.now())), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude \| 5h 77% · 7d 59%/);
  const saved = fs.readFileSync(path.join(dataDir, 'claude-subscription.json'), 'utf8');
  assert.ok(!saved.includes('private'));
});

test('Claude Stop publishes a private-free completion that the widget can poll with its quota', async t => {
  const dataDir = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'wc-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = Date.now();
  saveClaudeUsage(dataDir, sample(now), now);
  const stopped = spawnSync(process.execPath, ['scripts/claude-stop.mjs', '--data-dir', dataDir], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'private-session',
      last_assistant_message: 'private reply', transcript_path: '/private/chat.jsonl' }), encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(fs.readFileSync(path.join(dataDir, 'claude-last-turn.json'), 'utf8').includes('private'), false);
  const dispatcher = createDispatcher({ dataDir, monitor: false, autoRefresh: false });
  t.after(() => dispatcher.close());
  const event = JSON.parse((await dispatcher.dispatch('/api/claude/last-turn')).body);
  assert.equal(event.ok, true);
  assert.equal(event.provider, 'Claude');
  assert.ok(event.completedAt >= now);
  assert.equal(event.subscription.fiveHour.remainingPercent, 76.5);
  assert.equal(JSON.stringify(event).includes('private'), false);
  const bridge = await startBridge(dispatcher, { dataDir });
  t.after(() => bridge.close());
  assert.equal((await bridgeRequest('/api/claude/last-turn', { dataDir })).id, event.id);
});

test('installer preserves unrelated settings, rejects another status line and removes only its own command', t => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-claude-settings-'));
  t.after(() => fs.rmSync(claudeHome, { recursive: true, force: true }));
  const file = path.join(claudeHome, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'other-script' } }));
  assert.throws(() => configureClaudeStatusline('install', { claudeHome }), /未覆盖/);
  assert.equal(JSON.parse(fs.readFileSync(file)).statusLine.command, 'other-script');
  const original = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-script' }] }] } };
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(configureClaudeStatusline('install', { claudeHome, dataDir: '/tmp/whale data' }), 'installed');
  const installed = JSON.parse(fs.readFileSync(file));
  assert.equal(installed.theme, 'dark');
  assert.match(installed.statusLine.command, /claude-statusline\.mjs/);
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'other-script');
  for (const event of CLAUDE_TRACKED_EVENTS) assert.match(installed.hooks[event].at(-1).hooks[0].command, /claude-hook\.mjs/, event);
  assert.deepEqual(claudeIntegrationStatus({ claudeHome }), { installed: true, statusLine: 'pet', stop: true, tracking: true });
  assert.equal(configureClaudeStatusline('install', { claudeHome, dataDir: '/tmp/whale data' }), 'already-installed');
  assert.equal(configureClaudeStatusline('uninstall', { claudeHome }), 'uninstalled');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), original);
});

test('an install from before the task window is reported as outdated and updated in place', t => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-claude-upgrade-'));
  t.after(() => fs.rmSync(claudeHome, { recursive: true, force: true }));
  const file = path.join(claudeHome, 'settings.json'), script = name => "'" + path.resolve('scripts', name) + "'";
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: "'/usr/bin/node' " + script('claude-statusline.mjs') },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: "'/usr/bin/node' " + script('claude-stop.mjs'), timeout: 5 }] }] } }));
  assert.deepEqual(claudeIntegrationStatus({ claudeHome }), { installed: true, statusLine: 'pet', stop: true, tracking: false });
  assert.equal(configureClaudeStatusline('install', { claudeHome, nodePath: '/usr/bin/node' }), 'installed');
  const upgraded = JSON.parse(fs.readFileSync(file));
  assert.equal(upgraded.hooks.Stop.length, 1, 'the old Stop hook is replaced, not doubled');
  assert.match(upgraded.hooks.Stop[0].hooks[0].command, /claude-hook\.mjs/);
  assert.equal(claudeIntegrationStatus({ claudeHome }).tracking, true);
  assert.equal(configureClaudeStatusline('uninstall', { claudeHome }), 'uninstalled');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
});
