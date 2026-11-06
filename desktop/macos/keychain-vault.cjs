const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Electron safeStorage uses the current user's OS secret store (macOS Keychain,
// Windows DPAPI, Linux libsecret/kwallet) for its encryption key. Keep only
// ciphertext in the widget data directory: using a command-line password tool
// would place the secret in an argument, which those systems document as
// insecure. Windows used to be treated as "no vault", which kept keys only in
// memory and lost them on every restart.
const VAULT_FILE = 'keychain-secrets.json';

function validRef(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value); }

function secretValue(value) {
  const secret = String(value || '').trim().replace(/^Bearer\s+/i, '');
  if (!secret || secret.length > 16384 || /[\0\r\n]/.test(secret)) throw new Error('API 密钥格式无效');
  return secret;
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { version: 1, entries: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: {} };
    return { version: 1, entries: {} };
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

class KeychainVault {
  constructor({ dataDir, safeStorage, platform = process.platform } = {}) {
    this.file = path.join(dataDir || '', VAULT_FILE);
    this.safeStorage = safeStorage;
    this.platform = platform;
  }

  available() {
    try {
      if (!this.safeStorage?.isEncryptionAvailable?.()) return false;
      if (this.platform === 'darwin' || this.platform === 'win32') return true;
      // Electron's Linux fallback "basic_text" is not encryption; do not claim
      // a persistent vault for it.
      if (this.platform === 'linux') return this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
      return false;
    } catch { return false; }
  }

  read(keyRef) {
    if (!validRef(keyRef)) return { available: false, status: 'keychain-unavailable' };
    if (!this.available()) return { available: false, status: 'keychain-unavailable' };
    const encoded = readJson(this.file).entries?.[keyRef];
    if (typeof encoded !== 'string' || encoded.length < 8 || encoded.length > 65536) return { available: false, status: 'keychain-missing' };
    try {
      const value = secretValue(this.safeStorage.decryptString(Buffer.from(encoded, 'base64')));
      return { available: true, value, status: 'ready' };
    } catch { return { available: false, status: 'keychain-unavailable' }; }
  }

  write(keyRef, value) {
    if (!validRef(keyRef)) throw new Error('数据源的钥匙串标识无效');
    if (!this.available()) throw new Error('系统安全存储当前不可用；请解锁系统账户后重试');
    const secret = secretValue(value);
    let encrypted;
    try { encrypted = this.safeStorage.encryptString(secret); }
    catch { throw new Error('无法使用系统安全存储加密此密钥'); }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('无法使用系统安全存储加密此密钥');
    const vault = readJson(this.file);
    const entries = vault.entries && typeof vault.entries === 'object' && !Array.isArray(vault.entries) ? vault.entries : {};
    entries[keyRef] = encrypted.toString('base64');
    writeJson(this.file, { version: 1, entries });
  }
}

module.exports = { KeychainVault, VAULT_FILE };
