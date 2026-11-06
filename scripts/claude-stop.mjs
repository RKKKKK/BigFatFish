import path from 'node:path';
import { DATA_HOME } from '../runtime/paths.mjs';
import { saveClaudeTurn } from '../runtime/claude-usage.mjs';

const index = process.argv.indexOf('--data-dir');
const dataDir = index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : DATA_HOME;
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16 * 1024 * 1024) throw new Error('hook input too large');
  }
  saveClaudeTurn(dataDir, JSON.parse(input));
} catch {
  // Completion notifications must never interrupt Claude's response.
}
