import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_HOME, ROOT, readJson, writeJson } from './paths.mjs';
import { CLAUDE_TRACKED_EVENTS } from './agents/claude-hooks.mjs';

// Connects Claude Code to the pet: its status line reports the subscription
// quota and the tokens in each conversation, and its hooks report what each
// session is doing, for the task window and the finished-reply notice. Only
// the pet's own commands are ever added or removed; anything else in the
// settings stays.
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const script = name => quote(path.join(ROOT, 'scripts', name));
const ownedCommand = value => typeof value === 'string' && value.includes(script('claude-statusline.mjs'));
// claude-stop.mjs is the Stop hook of earlier versions.
const ownedHook = (value, names = ['claude-hook.mjs', 'claude-stop.mjs']) => value?.type === 'command' && typeof value.command === 'string' &&
  names.some(name => value.command.includes(script(name)));
const withoutOwn = groups => groups.map(group => ({ ...group,
  hooks: Array.isArray(group?.hooks) ? group.hooks.filter(hook => !ownedHook(hook)) : group?.hooks
})).filter(group => !Array.isArray(group.hooks) || group.hooks.length);
const hasOwn = (groups, names) => Array.isArray(groups) && groups.some(group => Array.isArray(group?.hooks) && group.hooks.some(hook => ownedHook(hook, names)));
const defaultNodePath = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(candidate => fs.existsSync(candidate)) || process.execPath;
// Inside the desktop app the fallback runtime is Electron, which runs scripts as Node only when told to.
const runner = nodePath => (process.versions.electron && nodePath === process.execPath ? 'ELECTRON_RUN_AS_NODE=1 ' : '') + quote(nodePath);

export function configureClaudeStatusline(action, { claudeHome = path.join(os.homedir(), '.claude'), dataDir = DATA_HOME, nodePath = defaultNodePath } = {}) {
  const settingsFile = path.join(claudeHome, 'settings.json');
  const settings = readJson(settingsFile, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude 设置不是 JSON 对象');
  const hooks = settings.hooks || {};
  if (typeof hooks !== 'object' || Array.isArray(hooks) || Object.values(hooks).some(groups => groups && !Array.isArray(groups))) throw new Error('Claude hooks 设置格式无效');
  if (action === 'install') {
    if (settings.statusLine && !ownedCommand(settings.statusLine.command)) throw new Error('Claude 已配置其他状态栏命令，未覆盖');
    const command = runner(nodePath) + ' ' + [path.join(ROOT, 'scripts', 'claude-statusline.mjs'), '--data-dir', dataDir].map(quote).join(' ');
    const hookCommand = runner(nodePath) + ' ' + [path.join(ROOT, 'scripts', 'claude-hook.mjs'), '--data-dir', dataDir].map(quote).join(' ');
    const nextHooks = { ...hooks };
    for (const event of CLAUDE_TRACKED_EVENTS) nextHooks[event] = [...withoutOwn(hooks[event] || []), { hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }];
    const next = { ...settings, statusLine: { type: 'command', command }, hooks: nextHooks };
    if (JSON.stringify(settings) === JSON.stringify(next)) return 'already-installed';
    writeJson(settingsFile, next);
    return 'installed';
  }
  if (action === 'uninstall') {
    const removeStatusLine = ownedCommand(settings.statusLine?.command);
    const nextHooks = {};
    for (const [event, groups] of Object.entries(hooks)) {
      const kept = Array.isArray(groups) ? withoutOwn(groups) : groups;
      if (!Array.isArray(kept) || kept.length) nextHooks[event] = kept;
    }
    const removedHooks = JSON.stringify(nextHooks) !== JSON.stringify(hooks);
    if (!removeStatusLine && !removedHooks) return 'not-installed';
    const rest = { ...settings };
    if (removeStatusLine) delete rest.statusLine;
    if (Object.keys(nextHooks).length) rest.hooks = nextHooks; else delete rest.hooks;
    writeJson(settingsFile, rest);
    return 'uninstalled';
  }
  throw new Error('Use install or uninstall');
}

// Whether Claude Code reports to the pet: its status line and Stop hook are
// the pet's. `tracking` adds the hooks the task window needs, which earlier
// versions did not install.
export function claudeIntegrationStatus({ claudeHome = path.join(os.homedir(), '.claude') } = {}) {
  let settings;
  try { settings = readJson(path.join(claudeHome, 'settings.json'), {}); } catch { return { installed: false, statusLine: 'unreadable', stop: false, tracking: false }; }
  const statusLine = !settings?.statusLine ? 'none' : ownedCommand(settings.statusLine.command) ? 'pet' : 'other';
  const stop = hasOwn(settings?.hooks?.Stop);
  const tracking = statusLine === 'pet' && CLAUDE_TRACKED_EVENTS.every(event => hasOwn(settings?.hooks?.[event], ['claude-hook.mjs']));
  return { installed: statusLine === 'pet' && stop, statusLine, stop, tracking };
}
