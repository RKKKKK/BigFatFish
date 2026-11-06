import fs from 'node:fs';
import path from 'node:path';
import { DATA_HOME } from '../runtime/paths.mjs';

if (process.platform !== 'darwin') {
  process.stderr.write('This diagnostic is only for macOS.\n');
  process.exit(1);
}

const configFile = path.join(DATA_HOME, 'follow-config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch {}
if (config.platform !== 'darwin' || config.enabled !== true) {
  process.stderr.write('The desktop service is not installed. Run scripts/install-macos.mjs first.\n');
  process.exit(1);
}
if (!config.electronPath || !fs.existsSync(config.electronPath)) {
  process.stderr.write('Desktop runtime is missing. Run scripts/install-macos.mjs first.\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, platform: 'darwin', electronPath: config.electronPath }) + '\n');
