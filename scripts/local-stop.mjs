// 本地部署的停止入口：先请 supervisor 优雅退出，再收掉可能残留的挂件进程。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopEverything } from './local-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.WHALE_HOME) process.env.WHALE_HOME = path.join(ROOT, '.whale-home');

const { DATA_HOME } = await import('../runtime/paths.mjs');

const left = await stopEverything(DATA_HOME);
if (left.supervisors.length || left.electrons.length) {
  process.stderr.write('仍有进程未退出：supervisor=' + left.supervisors.join(',') + ' electron=' + left.electrons.join(',') + '\n');
  process.exit(1);
}
process.stdout.write('大肥鱼已停止。\n');
process.exit(0);
