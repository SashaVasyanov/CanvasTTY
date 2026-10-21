// Usage limits for agents / providers.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

async function newestFiles(dir, depth, acc = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  if (depth > 0) {
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse().slice(0, 3);
    for (const d of dirs) await newestFiles(path.join(dir, d), depth - 1, acc);
  } else {
    for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(path.join(dir, e.name));
  }
  return acc;
}

async function tail(file, bytes = 400 * 1024) {
  const fh = await fsp.open(file, 'r');
  try {
    const st = await fh.stat();
    const start = Math.max(0, st.size - bytes);
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

function windowLabel(min) {
  if (!min) return '';
  if (min <= 300) return `${Math.round(min / 60)}ч`;
  if (min >= 10080) return 'Неделя';
  if (min >= 1440) return `${Math.round(min / 1440)}д`;
  return `${Math.round(min / 60)}ч`;
}

async function codexLimits() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessions = path.join(home, 'sessions');
  if (!fs.existsSync(home)) return { status: 'na', note: 'Codex не установлен' };
  let files = await newestFiles(sessions, 3);
  if (!files.length) return { status: 'na', note: 'Нет сессий Codex' };
  const stats = await Promise.all(files.map(async (f) => ({ f, m: (await fsp.stat(f)).mtimeMs })));
  stats.sort((a, b) => b.m - a.m);
  for (const { f, m } of stats.slice(0, 6)) {
    let text;
    try { text = await tail(f); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('rate_limits')) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const rl = (j.payload && (j.payload.rate_limits || (j.payload.info && j.payload.info.rate_limits))) || j.rate_limits;
      if (!rl) continue;
      const ts = j.timestamp ? Date.parse(j.timestamp) : m;
      const win = (w, fallback) => {
        if (!w) return null;
        let resetsAt = null;
        if (w.resets_at) resetsAt = typeof w.resets_at === 'number' ? w.resets_at * 1000 : Date.parse(w.resets_at);
        else if (w.resets_in_seconds != null) resetsAt = ts + w.resets_in_seconds * 1000;
        let used = Number(w.used_percent);
        if (resetsAt && resetsAt < Date.now()) used = 0; // window already reset
        return { label: windowLabel(w.window_minutes) || fallback, used: Math.round(used), resetsAt };
      };
      const windows = [win(rl.primary, '5ч'), win(rl.secondary, 'Неделя')].filter(Boolean);
      if (windows.length) return { status: 'ok', windows, updatedAt: ts, source: 'сессии ~/.codex' };
    }
  }
  return { status: 'na', note: 'Лимиты появятся после первого запроса в Codex' };
}

let claudeCache = { at: 0, data: null };
async function claudeLimits() {
  if (Date.now() - claudeCache.at < 60 * 1000 && claudeCache.data) return claudeCache.data;
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const credFile = path.join(dir, '.credentials.json');
  if (!fs.existsSync(dir)) return { status: 'na', note: 'Claude Code не установлен' };
  let token = null;
  try {
    const j = JSON.parse(await fsp.readFile(credFile, 'utf8'));
    const o = j.claudeAiOauth || j.claude_ai_oauth || {};
    token = o.accessToken;
    if (o.expiresAt && o.expiresAt < Date.now()) return { status: 'na', note: 'Токен истёк — запустите claude' };
  } catch { return { status: 'na', note: 'Войдите в Claude Code (/login)' }; }
  if (!token) return { status: 'na', note: 'Нет OAuth-токена' };
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'VibeTabula/1.0', Accept: 'application/json' },
    });
    if (!res.ok) return { status: 'error', note: `HTTP ${res.status}` };
    const j = await res.json();
    const w = (o, label) => o && o.utilization != null ? { label, used: Math.round(o.utilization), resetsAt: o.resets_at ? Date.parse(o.resets_at) : null } : null;
    const windows = [w(j.five_hour, '5ч'), w(j.seven_day, 'Неделя'), w(j.seven_day_opus, 'Opus')].filter(Boolean);
    const data = windows.length ? { status: 'ok', windows, updatedAt: Date.now(), source: 'аккаунт Claude' } : { status: 'na', note: 'Нет данных' };
    claudeCache = { at: Date.now(), data };
    return data;
  } catch (e) { return { status: 'error', note: e.message }; }
}

async function moonshotBalance(key, baseUrl) {
  if (!key) return null;
  try {
    const base = (baseUrl || 'https://api.moonshot.ai/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/users/me/balance`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return { status: 'error', note: `HTTP ${res.status}` };
    const j = await res.json();
    const d = j.data || {};
    const cur = base.includes('.cn') ? '¥' : '$';
    return { status: 'ok', balance: { amount: Number(d.available_balance || 0), currency: cur }, updatedAt: Date.now(), source: 'Moonshot API' };
  } catch (e) { return { status: 'error', note: e.message }; }
}

async function openrouterKey(key) {
  if (!key) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return { status: 'error', note: `HTTP ${res.status}` };
    const d = (await res.json()).data || {};
    if (d.limit) return { status: 'ok', windows: [{ label: 'Лимит', used: Math.round((d.usage / d.limit) * 100), resetsAt: null }], balance: { amount: d.limit - d.usage, currency: '$' }, updatedAt: Date.now() };
    return { status: 'ok', balance: { amount: -Number(d.usage || 0), currency: '$', spent: true }, updatedAt: Date.now() };
  } catch (e) { return { status: 'error', note: e.message }; }
}

async function deepseekBalance(key) {
  if (!key) return null;
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return { status: 'error', note: `HTTP ${res.status}` };
    const j = await res.json();
    const b = (j.balance_infos || [])[0] || {};
    return { status: 'ok', balance: { amount: Number(b.total_balance || 0), currency: b.currency === 'CNY' ? '¥' : '$' }, updatedAt: Date.now() };
  } catch (e) { return { status: 'error', note: e.message }; }
}

function localUsage(providerId, settings, usageLog) {
  const budget = Number(settings.providers && settings.providers[providerId] && settings.providers[providerId].dailyBudget) || 0;
  const today = new Date().toISOString().slice(0, 10);
  const u = (usageLog && usageLog[today] && usageLog[today][providerId]) || null;
  const tokens = u ? u.input + u.output : 0;
  if (!budget && !tokens) return null;
  const tomorrow = new Date(); tomorrow.setHours(24, 0, 0, 0);
  return {
    status: 'ok',
    windows: budget ? [{ label: 'День', used: Math.min(100, Math.round((tokens / budget) * 100)), resetsAt: tomorrow.getTime() }] : [],
    tokens,
    note: budget ? null : `${tokens.toLocaleString('ru-RU')} ток. сегодня`,
    source: 'локальный учёт',
    updatedAt: Date.now(),
  };
}

async function getLimits({ settings, usageLog, rateLimits }) {
  const p = (settings && settings.providers) || {};
  const [codex, claude, kimi, openrouter, deepseek] = await Promise.all([
    codexLimits().catch((e) => ({ status: 'error', note: e.message })),
    claudeLimits().catch((e) => ({ status: 'error', note: e.message })),
    moonshotBalance(p.moonshot && p.moonshot.key, p.moonshot && p.moonshot.baseUrl),
    openrouterKey(p.openrouter && p.openrouter.key),
    deepseekBalance(p.deepseek && p.deepseek.key),
  ]);
  const out = { codex, claude };
  out.kimi = kimi || localUsage('moonshot', settings, usageLog) || { status: 'na', note: 'Добавьте ключ Moonshot' };
  if (openrouter) out.openrouter = openrouter;
  if (deepseek) out.deepseek = deepseek;
  for (const id of ['openai', 'anthropic', 'gemini', 'ollama', 'custom']) {
    const rl = rateLimits && rateLimits[id];
    const local = localUsage(id, settings, usageLog);
    if (rl && Date.now() - rl.at < 10 * 60 * 1000) out[id] = { status: 'ok', windows: [{ label: 'Rate', used: rl.used, resetsAt: rl.resetsAt }], source: 'заголовки API', updatedAt: rl.at };
    else if (local) out[id] = local;
  }
  return out;
}

module.exports = { getLimits };
