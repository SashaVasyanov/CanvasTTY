// The first start on a computer: which agents are installed and signed in (main/agentsetup.js),
// the project folder, and what to start with (a chat with an agent, the «Фича» template, an empty
// canvas). Also later from the command palette and Settings → Агенты («Проверить агентов…»).
// Shown once per computer (localStorage vt:onboarded), only for a new workspace.
import { h, icon, badge, toast, modal } from './util.js';
import { state, native } from './state.js';

export const ONBOARD_KEY = 'vt:onboarded';
const LOGIN_HINT = { claude: 'в терминале введите /login', codex: 'войдите в открывшемся терминале', gemini: 'войдите в открывшемся терминале', kimi: 'войдите в открывшемся терминале' };

const done = () => { try { localStorage.setItem(ONBOARD_KEY, String(Date.now())); } catch {} };
export function onboarded() { try { return !!localStorage.getItem(ONBOARD_KEY); } catch { return true; } }
// a workspace nobody has used yet: one project, one canvas with nothing but the agents hub
export function looksNew() {
  const ps = state.ws?.projects || [];
  return ps.length === 1 && ps[0].canvases.length === 1 && (state.doc?.nodes || []).every((n) => n.type === 'hub');
}
// on start: the window for a new workspace; an existing one just counts as onboarded
export function maybeOnboard(app) {
  if (onboarded() || state.info.test) return false;
  if (!looksNew()) { done(); return false; }
  setTimeout(() => openOnboarding(app, { first: true }), 300);
  return true;
}

export function openOnboarding(app, { first = false } = {}) {
  const list = h('div', { class: 'ob-agents' });
  let found = [];
  const row = (r) => {
    const a = state.agent(r.id);
    const status = !r.found ? h('span', { class: 'ob-st off' }, 'не установлен')
      : r.login === true ? h('span', { class: 'ob-st ok' }, `✓ готов${r.account ? ` · ${r.account}` : ''}`)
        : r.login === false ? h('span', { class: 'ob-st wait' }, 'установлен, вход не выполнен')
          : h('span', { class: 'ob-st ok' }, '✓ установлен');
    const actions = [];
    if (!r.found && a.install) actions.push(h('button', { class: 'btn sm', title: a.install, onclick: () => { native.clipboard.write(a.install); toast(`Скопировано: ${a.install} — выполните в терминале, затем «Проверить ещё раз»`); } }, 'Скопировать команду установки'));
    if (r.found && r.login === false) actions.push(h('button', { class: 'btn sm primary', onclick: () => signIn(r.id) }, 'Войти'));
    return h('div', { class: `ob-agent ${r.found ? 'found' : ''}`, 'data-id': r.id },
      badge(a.mono, a.color, 26, a.dark),
      h('div', { class: 'ob-main' },
        h('div', { class: 'ob-name' }, a.name, r.version ? h('span', { class: 'ob-ver' }, r.version) : null),
        status,
        r.found && r.login === null ? h('div', { class: 'muted small' }, 'Вход проверится при первом запуске агента') : null,
        !r.found && a.install ? h('code', { class: 'ob-cmd' }, a.install) : null),
      h('div', { class: 'ob-acts' }, ...actions));
  };
  const check = async () => {
    list.replaceChildren(h('div', { class: 'muted ob-wait' }, 'Проверяю, какие агенты установлены…'));
    let rows = [];
    try { rows = await native.agents.detect(); } catch (e) { list.replaceChildren(h('div', { class: 'muted' }, `Не удалось проверить: ${e.message || e}`)); return; }
    found = rows.filter((r) => r.found);
    list.replaceChildren(...rows.map(row));
    if (!found.length) list.append(h('div', { class: 'ob-none' }, 'Ни одного агента не нашлось. Установите хотя бы один (команда выше), затем «Проверить ещё раз». Без агентов работают заметки, холсты и чаты по API-ключу (Настройки → API-провайдеры).'));
    paintStart();
  };
  // a terminal with the agent next to the hub, to sign in there
  const signIn = (id) => {
    const a = state.agent(id);
    const extra = id === 'codex' ? 'login' : '';
    if (extra) native.trust?.add([[a.cmd, a.args, extra].filter(Boolean).join(' ')]);
    const n = app.canvas.addNode('terminal', { x: 520, y: -120, data: { agentId: id, ...(extra ? { extraArgs: extra } : {}) } }, { center: false });
    app.canvas.focusNode(n.id);
    toast(`${a.name}: ${LOGIN_HINT[id] || 'войдите в терминале'}, затем «Проверить ещё раз»`, 'info', 6000);
  };

  // the project folder
  const cwdText = h('code', { class: 'ob-cwd' });
  const paintCwd = () => { cwdText.textContent = state.project.cwd || state.info.home || ''; };
  paintCwd();
  const folder = h('div', { class: 'ob-folder' }, cwdText, h('button', { class: 'btn sm', onclick: async () => { const d = await native.dialog.folder('Рабочая папка проекта'); if (d) { state.updateProject(state.project.id, { cwd: d }); paintCwd(); } } }, 'Выбрать…'));

  // what to start with (the first start only)
  let start = 'chat';
  const startBox = h('div', { class: 'ob-start' });
  const paintStart = () => {
    if (!first) return;
    const ready = found.find((r) => r.login !== false && state.agent(r.id).chat) || found.find((r) => state.agent(r.id).chat);
    const opts = [
      ready ? ['chat', `Окно чата с ${state.agent(ready.id).name}`, 'Пишете задачу — агент работает в папке проекта'] : null,
      ['template', 'Шаблон «Фича»', 'Область с описанием, агент для плана и агент для реализации, чек-лист готовности'],
      ['empty', 'Пустой холст', 'Добавите окна сами — кнопка «Агент» внизу'],
    ].filter(Boolean);
    if (!opts.some((o) => o[0] === start)) start = opts[0][0];
    startBox._agent = ready?.id;
    startBox.replaceChildren(...opts.map(([v, label, hint]) => h('label', { class: `ob-opt${v === start ? ' on' : ''}` },
      h('input', { type: 'radio', name: 'ob-start', value: v, checked: v === start, onchange: () => { start = v; paintStart(); } }),
      h('div', {}, h('div', { class: 'ob-opt-t' }, label), h('div', { class: 'muted small' }, hint)))));
  };

  const finish = async () => {
    done();
    if (!first) return;
    if (start === 'chat' && startBox._agent) app.launchAgentChat({ agentId: startBox._agent, world: { x: 520, y: -160 } });
    else if (start === 'template') {
      const { allTemplates, placeTemplate } = await import('./templates.js');
      const t = allTemplates().find((x) => x.id === 'tpl_feature');
      if (t) placeTemplate(app.canvas, t, { x: 600, y: -200 });
    }
  };
  const body = h('div', { class: 'ob' },
    first ? h('p', { class: 'ob-lead' }, 'VibeTabula — бесконечный холст для агентов: окна чатов с Claude Code и Codex по вашей подписке, терминалы, заметки и стрелки между ними. Сначала проверим, что есть на этом компьютере.') : null,
    h('div', { class: 'ob-head' }, h('b', {}, 'Агенты на этом компьютере'), h('span', { class: 'flex' }), h('button', { class: 'btn sm', html: `${icon('refresh', 12)} Проверить ещё раз`, onclick: check })),
    list,
    h('div', { class: 'ob-head' }, h('b', {}, 'Папка проекта')),
    h('div', { class: 'muted small' }, 'В ней агенты читают и меняют файлы. Можно поменять позже: меню проекта → «Настройки проекта».'),
    folder,
    first ? h('div', { class: 'ob-head' }, h('b', {}, 'С чего начать')) : null,
    first ? startBox : null);
  modal({
    title: first ? 'Добро пожаловать в VibeTabula' : 'Агенты на этом компьютере', width: 620, className: 'ob-modal', body,
    onClose: done,
    actions: first ? [{ label: 'Позже' }, { label: 'Начать', primary: true, onClick: () => { finish(); return true; } }] : [{ label: 'Готово', primary: true }],
  });
  check();
}
