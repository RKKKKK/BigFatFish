import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, VERSION } from '../runtime/paths.mjs';

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'qa-output', '.agents', '.codex'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) files.push(file);
  }
}
walk(ROOT);
function check(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error([command, ...args].join(' ') + '\n' + (result.error?.message || result.stderr || result.stdout));
}
const javascript = files.filter(file => /\.(?:js|mjs|cjs)$/.test(file));
for (const file of javascript) check(process.execPath, ['--check', file]);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json')));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json')));
if ([manifest.version.split('+')[0], pkg.version, lock.version, lock.packages[''].version].some(version => version !== VERSION)) throw new Error('Version declarations disagree.');
if (process.platform === 'darwin') {
  for (const file of files.filter(file => file.endsWith('.command') || file.endsWith('/Contents/MacOS/LaunchWhale'))) check('/bin/zsh', ['-n', file]);
  check('/usr/bin/plutil', ['-lint', path.join(ROOT, '启动桌面挂件.app', 'Contents', 'Info.plist')]);
}
check('git', ['-C', ROOT, 'diff', '--check']);
process.stdout.write('Source checks passed: ' + javascript.length + ' JavaScript files, version declarations, whitespace' + (process.platform === 'darwin' ? ', macOS launcher syntax and plist' : '') + '.\n');
