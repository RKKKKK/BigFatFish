import path from 'node:path';
import { DATA_HOME } from '../runtime/paths.mjs';
import { captureClaudeUsage, saveClaudeUsage } from '../runtime/claude-usage.mjs';
import { recordClaudeStatus } from '../runtime/agents/claude-hooks.mjs';

const index = process.argv.indexOf('--data-dir');
const dataDir = index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : DATA_HOME;
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 128 * 1024) throw new Error('status line input too large');
  }
  const data = JSON.parse(input);
  saveClaudeUsage(dataDir, data);
  try { recordClaudeStatus(dataDir, data); } catch {}
  const rate = captureClaudeUsage(data);
  const five = rate?.fiveHour?.usedPercent, week = rate?.sevenDay?.usedPercent;
  const parts = [typeof five === 'number' ? `5h ${Math.round(100 - five)}%` : '',
    typeof week === 'number' ? `7d ${Math.round(100 - week)}%` : ''].filter(Boolean);
  process.stdout.write(parts.length ? `Claude | ${parts.join(' · ')}\n` : 'Claude\n');
} catch {
  process.stdout.write('Claude\n');
}
