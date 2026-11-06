import path from 'node:path';
import { DATA_HOME } from '../runtime/paths.mjs';
import { recordClaudeHook } from '../runtime/agents/claude-hooks.mjs';

// Claude Code runs this on each event the task window follows. It prints
// nothing: output from some events would join the conversation.
const index = process.argv.indexOf('--data-dir');
const dataDir = index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : DATA_HOME;
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16 * 1024 * 1024) throw new Error('hook input too large');
  }
  recordClaudeHook(dataDir, JSON.parse(input));
} catch {
  // The pet's hook must never block or change what Claude does.
}
