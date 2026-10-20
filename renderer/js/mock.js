// Browser fallback for window.native, so the UI can run (and be tested) outside Electron.
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const listeners = {};
const on = (ch) => (cb) => { (listeners[ch] = listeners[ch] || []).push(cb); return () => { listeners[ch] = listeners[ch].filter((f) => f !== cb); }; };
const emit = (ch, p) => (listeners[ch] || []).forEach((f) => f(p));

const files = LS.get('mock:vault', null) || {
  'Добро пожаловать в CanvasTTY.md': '# Добро пожаловать в CanvasTTY\n\nЭто хранилище заметок — обычная папка с файлами **Markdown**, совместимая с Obsidian.\n\n## Что умеют заметки\n- [x] Ссылки между заметками: [[Идеи]]\n- [ ] Теги: #старт #canvas\n- [ ] Перетащите заметку из списка слева на canvas\n\n> Панель инструментов сверху работает как в Apple Notes.\n',
  'Идеи.md': '# Идеи\n\nОбратная ссылка: [[Добро пожаловать в CanvasTTY]]\n\n- Сделать агента для ревью кода #идея\n',
  'Проекты/Монтаж видео.md': '# Монтаж видео\n\n| Шаг | Статус |\n| --- | --- |\n| Сценарий | готов |\n| Нарезка | в работе |\n\nСм. [[Идеи]]\n',
};
const saveFiles = () => LS.set('mock:vault', files);
const parse = (t) => {
  const links = [...t.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1].trim());
  const tags = [...t.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu)].map((m) => m[2]);
  return { links: [...new Set(links)], tags: [...new Set(tags)] };
};

const sessions = {};
let seq = 0;

export const mockNative = {
  isElectron: false,
  win: { minimize() {}, maximize() {}, close() {}, isMaximized: async () => false, onState: on('win:state') },
  info: async () => ({ version: '1.1.0', platform: 'browser', home: '/home/user' }),
  ws: { load: async () => LS.get('mock:ws', null), save: async (ws) => LS.set('mock:ws', ws) },
  canvas: { load: async (id) => LS.get(`mock:canvas:${id}`, null), save: async (id, d) => LS.set(`mock:canvas:${id}`, d), remove: async (id) => localStorage.removeItem(`mock:canvas:${id}`) },
  pty: {
    async spawn({ cmd }) {
      const id = `mock_${seq++}`;
      const s = sessions[id] = { line: '', buffer: '', last: Date.now(), cmd };
      const out = (d) => { s.buffer += d; s.last = Date.now(); emit('pty:data', { id, data: d }); };
      s.out = out;
      setTimeout(() => {
        out(`\x1b[38;5;111mCanvasTTY demo shell\x1b[0m — запущено в браузере, настоящий терминал работает в приложении.\r\n`);
        if (cmd) out(`\x1b[90m$ ${cmd}\x1b[0m\r\n\x1b[32m●\x1b[0m ${cmd}: агент готов. Напишите что-нибудь.\r\n`);
        out('\x1b[36m❯\x1b[0m ');
      }, 120);
      return { id, notFound: false };
    },
    write(id, data) {
      const s = sessions[id]; if (!s) return;
      for (const ch of data) {
        if (ch === '\r') { const l = s.line; s.line = ''; s.out('\r\n'); if (l.trim()) { let i = 0; const resp = `Принято: «${l}». (демо-ответ)`; const t = setInterval(() => { s.out(resp[i++] || ''); if (i > resp.length) { clearInterval(t); s.out('\r\n\x1b[36m❯\x1b[0m '); } }, 25); } else s.out('\x1b[36m❯\x1b[0m '); }
        else if (ch === '\x7f') { if (s.line) { s.line = s.line.slice(0, -1); s.out('\b \b'); } }
        else if (ch >= ' ') { s.line += ch; s.out(ch); }
      }
    },
    resize() {}, kill: async (id) => { delete sessions[id]; },
    attach: async (id) => sessions[id] ? { id, buffer: sessions[id].buffer, exited: false, lastOutput: sessions[id].last } : null,
    statuses: async () => Object.fromEntries(Object.entries(sessions).map(([id, s]) => [id, { exited: false, busy: Date.now() - s.last < 2500, lastOutput: s.last }])),
    which: async () => '/usr/bin/demo',
    onData: on('pty:data'), onExit: on('pty:exit'),
  },
  chat: {
    providers: async () => ({
      openai: { name: 'OpenAI', model: 'gpt-5' }, anthropic: { name: 'Anthropic', model: 'claude-sonnet-5-5' },
      moonshot: { name: 'Kimi (Moonshot)', model: 'kimi-k2-turbo-preview' }, openrouter: { name: 'OpenRouter', model: 'openrouter/auto' },
      deepseek: { name: 'DeepSeek', model: 'deepseek-chat' }, gemini: { name: 'Gemini', model: 'gemini-2.5-flash' },
      ollama: { name: 'Ollama (локально)', model: 'llama3.1', noKey: true }, custom: { name: 'Свой (OpenAI-совместимый)', model: 'local-model', noKey: true },
    }),
    async send({ reqId, messages, system }) {
      const last = messages[messages.length - 1]?.content || '';
      const text = `Это **демо-ответ** (в браузере нет доступа к API).\n\nВы написали: _${last.slice(0, 80)}_\n\n${system ? `Контекст получен: ${system.length} символов.\n\n` : ''}\`\`\`js\nconsole.log('hello from CanvasTTY');\n\`\`\``;
      let i = 0;
      const t = setInterval(() => {
        const chunk = text.slice(i, i + 6); i += 6;
        if (chunk) emit('chat:event', { reqId, type: 'delta', text: chunk });
        else { clearInterval(t); emit('chat:event', { reqId, type: 'done', usage: { input: 120, output: 60 } }); }
      }, 20);
      return true;
    },
    abort: async () => {}, models: async () => ['demo-model-1', 'demo-model-2'], onEvent: on('chat:event'),
  },
  agentChat: {
    async run({ reqId, prompt, kind }) {
      const ev = (type, p = {}) => emit('agentchat:event', { reqId, type, ...p });
      const steps = [
        () => ev('session', { sessionId: 'demo-session-1234' }),
        () => ev('delta', { text: 'Смотрю структуру проекта.' }),
        () => ev('break'),
        () => ev('tool', { id: 't1', name: kind === 'codex' ? 'Команда' : 'Bash', input: 'ls -la' }),
        () => ev('toolResult', { id: 't1', output: 'main/\nrenderer/\npackage.json\nREADME.md' }),
        () => ev('tool', { id: 't2', name: kind === 'codex' ? 'Файлы' : 'Edit', input: 'README.md' }),
        () => ev('toolResult', { id: 't2', output: 'Файл обновлён' }),
      ];
      const asked = prompt.split('---').pop().trim();
      const text = `Готово! Это **демо-ответ** агента в браузере. Задача: _${asked.slice(0, 60)}_`;
      let i = 0;
      const t = setInterval(() => {
        if (i < steps.length) { steps[i++](); return; }
        const k = i++ - steps.length;
        const chunk = text.slice(k * 8, k * 8 + 8);
        if (chunk) ev('delta', { text: chunk });
        else { clearInterval(t); ev('done', { sessionId: 'demo-session-1234', cost: 0.0123, usage: { input: 1200, output: 300 } }); }
      }, 90);
      return true;
    },
    abort: async () => {}, onEvent: on('agentchat:event'),
  },
  setBg: async () => {},
  limits: {
    get: async () => ({
      codex: { status: 'ok', windows: [{ label: '5ч', used: 10, resetsAt: Date.now() + 3.2 * 3600e3 }, { label: 'Неделя', used: 34, resetsAt: Date.now() + 4 * 86400e3 }], source: 'демо' },
      claude: { status: 'ok', windows: [{ label: '5ч', used: 62, resetsAt: Date.now() + 1.5 * 3600e3 }, { label: 'Неделя', used: 21, resetsAt: Date.now() + 2 * 86400e3 }], source: 'демо' },
      kimi: { status: 'ok', windows: [{ label: 'День', used: 18, resetsAt: Date.now() + 8 * 3600e3 }], source: 'демо' },
    }),
    usage: async () => ({}),
  },
  vault: {
    root: async () => '/demo/CanvasTTY Vault',
    setRoot: async (p) => p,
    async index() {
      const notes = Object.entries(files).filter(([p]) => p.endsWith('.md')).map(([p, t]) => ({ path: p, name: p.split('/').pop().replace(/\.md$/, ''), mtime: Date.now(), ...parse(t), preview: t.replace(/[#>*`\[\]_~-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) }));
      const folders = [...new Set(Object.keys(files).filter((p) => p.includes('/')).map((p) => p.split('/').slice(0, -1).join('/')))];
      return { root: '/demo/CanvasTTY Vault', notes, folders, assets: [] };
    },
    read: async (p) => { if (!(p in files)) throw new Error('not found'); return files[p]; },
    write: async (p, c) => { files[p] = c; saveFiles(); emit('vault:changed', { file: p }); return true; },
    async create(folder, name, content = '') { let base = (folder ? folder + '/' : '') + (name || 'Без названия'); let p = base + '.md', i = 1; while (p in files) p = `${base} ${i++}.md`; files[p] = content; saveFiles(); emit('vault:changed', { file: p }); return p; },
    mkdir: async (p) => { files[p + '/.keep'] = ''; saveFiles(); return p; },
    async rename(a, b) { files[b] = files[a]; delete files[a]; saveFiles(); emit('vault:changed', {}); return b; },
    remove: async (p) => { delete files[p]; for (const k of Object.keys(files)) if (k.startsWith(p + '/')) delete files[k]; saveFiles(); emit('vault:changed', {}); return true; },
    async search(q) { q = q.toLowerCase(); return Object.entries(files).filter(([p, t]) => p.endsWith('.md') && (p.toLowerCase().includes(q) || t.toLowerCase().includes(q))).map(([p, t]) => { const i = t.toLowerCase().indexOf(q); return { path: p, name: p.split('/').pop().replace(/\.md$/, ''), matches: i >= 0 ? [{ before: t.slice(Math.max(0, i - 40), i), hit: t.slice(i, i + q.length), after: t.slice(i + q.length, i + q.length + 60) }] : [] }; }); },
    saveAsset: async (dataUrl) => { const p = `attachments/img-${Date.now()}.png`; files[p] = dataUrl; saveFiles(); return p; },
    readAsset: async (p) => files[p] || '',
    reveal: async () => {}, onChanged: on('vault:changed'),
  },
  dialog: { folder: async () => '/demo/project' },
  shell: { open: async (u) => window.open(u, '_blank'), openPath: async () => {} },
  clipboard: { write: async (t) => navigator.clipboard?.writeText(t) },
};
