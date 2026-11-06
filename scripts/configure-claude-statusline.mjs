import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureClaudeStatusline } from '../runtime/claude-integration.mjs';

export { configureClaudeStatusline };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(configureClaudeStatusline(process.argv[2]) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
