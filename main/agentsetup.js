// The first start (and «Проверить агентов на этом компьютере…»): which agent CLIs are installed,
// their versions and whether they are signed in — read from their own files on this computer,
// nothing is sent anywhere. Only the stock commands are run (`<cli> --version`): the agent commands
// in the settings may come from another computer through sync (see trust.js).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { which, run } = require('./which');

const AGENTS = ['claude', 'codex', 'gemini', 'kimi'];
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// { login: true | false | null (cannot tell), account }
function login(id) {
  const home = os.homedir();
  if (id === 'claude') {
    const base = process.env.CLAUDE_CONFIG_DIR;
    const cfg = readJson(path.join(base || home, '.claude.json'));
    if (cfg?.oauthAccount) return { login: true, account: String(cfg.oauthAccount.emailAddress || '') };
    if (fs.existsSync(path.join(base || path.join(home, '.claude'), '.credentials.json'))) return { login: true, account: '' };
    if (process.env.ANTHROPIC_API_KEY) return { login: true, account: 'ключ API' };
    return { login: process.platform === 'darwin' ? null : false, account: '' }; // macOS keeps the login in the keychain
  }
  if (id === 'codex') {
    const a = readJson(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'));
    if (a?.tokens) return { login: true, account: '' };
    if (a?.OPENAI_API_KEY || process.env.OPENAI_API_KEY) return { login: true, account: 'ключ API' };
    return { login: false, account: '' };
  }
  if (id === 'gemini') {
    if (fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json'))) return { login: true, account: '' };
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { login: true, account: 'ключ API' };
    return { login: null, account: '' };
  }
  return { login: null, account: '' };
}

// → [{ id, found, path, version, login, account }]
async function detect() {
  return Promise.all(AGENTS.map(async (id) => {
    const p = which(id);
    if (!p) return { id, found: false };
    const r = await run(id, ['--version'], { timeout: 15_000 });
    const version = r.code === 0 ? ((r.stdout || r.stderr).split('\n').map((s) => s.trim()).find(Boolean) || '').slice(0, 60) : '';
    return { id, found: true, path: p, version, ...login(id) };
  }));
}

module.exports = { detect, login };
