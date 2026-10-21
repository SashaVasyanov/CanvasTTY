// API keys at rest: encrypted with the OS keychain (Windows DPAPI, macOS Keychain, libsecret) via
// Electron safeStorage, so workspace.json in a backup, a copied profile or another user's hands
// holds no usable keys. The renderer still works with plain values; old plaintext files migrate
// on the next save. If the OS has no keychain, values stay as they are.
const { safeStorage } = require('electron');

const PREFIX = 'enc:v1:';
const SECRET_FIELDS = ['key', 'apiKey', 'token'];
const can = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
const enc = (v) => (typeof v === 'string' && v && !v.startsWith(PREFIX) && can() ? PREFIX + safeStorage.encryptString(v).toString('base64') : v);
const dec = (v) => { if (typeof v !== 'string' || !v.startsWith(PREFIX)) return v; try { return safeStorage.decryptString(Buffer.from(v.slice(PREFIX.length), 'base64')); } catch { return ''; } };

function mapWs(ws, fn) {
  if (!ws || !ws.settings || !ws.settings.providers) return ws;
  const providers = {};
  for (const [id, p] of Object.entries(ws.settings.providers)) {
    if (!p || typeof p !== 'object') { providers[id] = p; continue; }
    const q = { ...p };
    for (const f of SECRET_FIELDS) if (f in q) q[f] = fn(q[f]);
    providers[id] = q;
  }
  return { ...ws, settings: { ...ws.settings, providers } };
}
const encodeWs = (ws) => mapWs(ws, enc);
const decodeWs = (ws) => mapWs(ws, dec);

module.exports = { encodeWs, decodeWs };
