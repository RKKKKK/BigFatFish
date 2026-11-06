import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_HOME, DATA_HOME, ROOT, readJson, writeJson } from '../runtime/paths.mjs';

const marker = '--whale-approval-hook';
const description = 'API Balance Whale approval reminder';
const ownHook = hook => hook?.type === 'command' && typeof hook.command === 'string' &&
  hook.command.includes('/scripts/approval-request-hook.mjs') && hook.command.includes(marker);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

function hookFile(codexHome) { return path.join(codexHome, 'hooks.json'); }
function readHooks(file) {
  const config = readJson(file, { description, hooks: {} });
  if (!config || typeof config !== 'object' || Array.isArray(config) || !config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    throw new Error('Codex hooks.json 格式无效');
  }
  if (config.hooks.PermissionRequest !== undefined && !Array.isArray(config.hooks.PermissionRequest)) throw new Error('Codex PermissionRequest hooks 格式无效');
  return config;
}

export function installApprovalHook({ codexHome = CODEX_HOME, dataDir = DATA_HOME, nodePath = process.execPath, root = ROOT } = {}) {
  const file = hookFile(codexHome);
  const config = readHooks(file);
  const command = [nodePath, path.join(root, 'scripts', 'approval-request-hook.mjs'), marker, '--data-dir', dataDir].map(quote).join(' ');
  const prior = config.hooks.PermissionRequest || [];
  if (prior.some(group => Array.isArray(group?.hooks) && group.hooks.some(hook => ownHook(hook) && hook.command === command))) return false;
  config.hooks.PermissionRequest = prior.map(group => ({ ...group, hooks: Array.isArray(group?.hooks) ? group.hooks.filter(hook => !ownHook(hook)) : group?.hooks }))
    .filter(group => !Array.isArray(group.hooks) || group.hooks.length);
  config.hooks.PermissionRequest.push({ hooks: [{ type: 'command', command, timeout: 3 }] });
  writeJson(file, config);
  return true;
}

export function uninstallApprovalHook({ codexHome = CODEX_HOME } = {}) {
  const file = hookFile(codexHome);
  if (!fs.existsSync(file)) return false;
  const config = readHooks(file);
  const prior = config.hooks.PermissionRequest || [];
  const next = prior.map(group => ({ ...group, hooks: Array.isArray(group?.hooks) ? group.hooks.filter(hook => !ownHook(hook)) : group?.hooks }))
    .filter(group => !Array.isArray(group.hooks) || group.hooks.length);
  if (JSON.stringify(prior) === JSON.stringify(next)) return false;
  if (next.length) config.hooks.PermissionRequest = next;
  else delete config.hooks.PermissionRequest;
  if (config.description === description && Object.keys(config.hooks).length === 0 && Object.keys(config).every(key => ['description', 'hooks'].includes(key))) fs.unlinkSync(file);
  else writeJson(file, config);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'install') process.stdout.write(installApprovalHook() ? 'Approval reminder hook installed; review it with /hooks in Codex.\n' : 'Approval reminder hook already installed.\n');
  else if (action === 'uninstall') process.stdout.write(uninstallApprovalHook() ? 'Approval reminder hook removed.\n' : 'Approval reminder hook was not installed.\n');
  else { process.stderr.write('Use install or uninstall.\n'); process.exitCode = 1; }
}
