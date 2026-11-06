import fs from 'node:fs';
import vm from 'node:vm';

export function browserModule(name, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../../desktop/ui/' + name, import.meta.url), 'utf8'), {
    module, AbortController, Intl, Date,
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args), ...globals,
  }, { filename: name });
  return module.exports;
}
