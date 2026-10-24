// The "agents hub" widget from the reference screenshot: limits, statuses, clock, pet, launch dock.
import { safeUrl } from './sanitize.js';
import { h, icon, badge, bus, relTime, Emitter, esc, modal, toast, menu, confirmBox } from './util.js';
import { state, native } from './state.js';
import { SpritePet, codexPets, codexPetFor, isCodexKind, loadCodexPets, PET_ROWS } from './companion.js';
import { paintActivity } from './activity.js';

// ---------------- clock colours ----------------
// d: the four digits (they overlap: screen blend on dark backgrounds, multiply on light ones)
export const CLOCK_PRESETS = {
  standby: { name: 'StandBy, синий', bg: '#000000', d: ['#1f6dff', '#59a6ff', '#2a7dff', '#6cb6ff'], colon: '#d9e9ff', date: '#7fb6ff' },
  sunset: { name: 'Закат', bg: '#000000', d: ['#ff4f2e', '#ff9f3d', '#ff6a45', '#ffc25c'], colon: '#ffe8d2', date: '#ffad6b' },
  mint: { name: 'Мята', bg: '#03110c', d: ['#10b981', '#5eeab5', '#1ccf96', '#8cf5cf'], colon: '#dcfff1', date: '#6fe3b4' },
  violet: { name: 'Фиалка', bg: '#07040f', d: ['#7444ff', '#b18aff', '#8a58ff', '#cdb1ff'], colon: '#efe6ff', date: '#b795ff' },
  neon: { name: 'Неон', bg: '#0b0008', d: ['#ff2e88', '#ff7ab8', '#ff4597', '#ffa6cf'], colon: '#ffe3f0', date: '#ff8cc1' },
  graphite: { name: 'Графит', bg: '#000000', d: ['#5d6472', '#c3c8d2', '#828997', '#e5e8ee'], colon: '#ffffff', date: '#a9afba' },
  paper: { name: 'Бумага', bg: '#ffffff', d: ['#1f6dff', '#7db8ff', '#3b84ff', '#a6ceff'], colon: '#1d4cb8', date: '#3569d4' },
  sky: { name: 'Небо', bg: '#eaf3ff', d: ['#2a64f6', '#8db7ff', '#4a7ffb', '#b5d1ff'], colon: '#1c3c94', date: '#3a62c7' },
  peach: { name: 'Персик', bg: '#fff3ea', d: ['#ff6433', '#ffae86', '#ff8152', '#ffcaa9'], colon: '#a83c18', date: '#df6438' },
  lilac: { name: 'Сирень', bg: '#f5f0ff', d: ['#7646ff', '#bfa1ff', '#9064ff', '#d8c7ff'], colon: '#45269a', date: '#7a52de' },
  matcha: { name: 'Матча', bg: '#f1f8ef', d: ['#2f9e5b', '#8fd3a6', '#4bb373', '#b5e3c4'], colon: '#1e5d36', date: '#3a8a59' },
};
export const CLOCK_DEFAULT = { dark: 'standby', light: 'paper' };
const lum = (hex) => { const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
export const isLightTheme = () => document.documentElement.dataset.theme === 'light';
export function clockColors(theme = isLightTheme() ? 'light' : 'dark') {
  const s = state.settings || {};
  const id = s[theme === 'light' ? 'clockLight' : 'clockDark'] || CLOCK_DEFAULT[theme];
  const c = id === 'custom' ? { ...CLOCK_PRESETS[CLOCK_DEFAULT[theme]], ...(s[theme === 'light' ? 'clockCustomLight' : 'clockCustomDark'] || {}) } : (CLOCK_PRESETS[id] || CLOCK_PRESETS[CLOCK_DEFAULT[theme]]);
  return { ...c, blend: lum(c.bg) > 0.5 ? 'multiply' : 'screen' };
}
export function paintClock(el, c = clockColors()) {
  el.style.setProperty('--sb-bg', c.bg);
  c.d.forEach((v, i) => el.style.setProperty(`--sb-d${i + 1}`, v));
  el.style.setProperty('--sb-colon', c.colon);
  el.style.setProperty('--sb-date', c.date);
  el.style.setProperty('--sb-blend', c.blend);
}
export function clockMarkup(hh = '19', mm = '08', date = '') {
  const dg = (ch, i) => `<span class="sb-d sb-d${i}">${ch}</span>`;
  return `<div class="sb-time" aria-label="${hh}:${mm}">${dg(hh[0], 1)}${dg(hh[1], 2)}<span class="sb-colon"><i></i><i></i></span>${dg(mm[0], 3)}${dg(mm[1], 4)}</div>${date ? `<div class="sb-date">${date}</div>` : ''}`;
}

// ---------------- limits store ----------------
class Limits extends Emitter {
  constructor() { super(); this.data = {}; this.loading = false; this.at = 0; }
  async refresh() {
    if (this.loading) return;
    this.loading = true;
    try { this.data = await native.limits.get(state.settings); this.at = Date.now(); }
    catch (e) { console.error(e); }
    this.loading = false;
    this.emit('change');
  }
}
export const limits = new Limits();
bus.on('limits:refresh', () => setTimeout(() => limits.refresh(), 800));
setInterval(() => limits.refresh(), 2 * 60 * 1000);

export const LIMIT_SOURCES = {
  codex: { name: 'Codex', agent: 'codex' },
  claude: { name: 'Claude Code', agent: 'claude' },
  kimi: { name: 'Kimi', agent: 'kimi' },
  openai: { name: 'OpenAI API', provider: 'openai' },
  anthropic: { name: 'Anthropic API', provider: 'anthropic' },
  openrouter: { name: 'OpenRouter', provider: 'openrouter' },
  deepseek: { name: 'DeepSeek', provider: 'deepseek' },
  gemini: { name: 'Gemini', provider: 'gemini' },
};

function sourceBadge(key, size) {
  const src = LIMIT_SOURCES[key];
  if (src?.agent) { const a = state.agent(src.agent); return badge(a.mono, a.color, size, a.dark); }
  return badge(key.slice(0, 2).toUpperCase(), '#59606f', size);
}

export function limitRow(key, info, { compact = false } = {}) {
  const src = LIMIT_SOURCES[key] || { name: key };
  const row = h('div', { class: `limit-row ${info?.status || 'na'}` });
  const main = info?.windows?.[0];
  const pct = main ? Math.max(0, Math.min(100, main.used)) : null;
  const level = pct == null ? '' : pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : '';
  const label = pct != null ? `${pct}%` : info?.balance ? `${info.balance.spent ? '−' : ''}${info.balance.currency}${Math.abs(info.balance.amount).toFixed(2)}` : '—';
  const sub = main ? `${main.label}${main.resetsAt ? ` · сброс ${relTime(main.resetsAt)}` : ''}` : (info?.note || (info?.balance ? 'баланс' : 'нет данных'));
  row.append(
    h('div', { class: 'lr-top' }, sourceBadge(key, compact ? 14 : 16), h('span', { class: 'lr-pct' }, label), h('span', { class: 'lr-name' }, compact ? '' : src.name), h('span', { class: 'lr-sub', title: info?.source ? `Источник: ${info.source}` : '' }, sub)),
    h('div', { class: `lr-bar ${level}` }, h('i', { style: { width: `${pct ?? 0}%` } })),
  );
  const second = info?.windows?.[1];
  if (second && !compact) {
    row.append(h('div', { class: 'lr-second' }, h('span', {}, `${second.label}: ${Math.round(second.used)}%`), h('div', { class: 'lr-bar thin' }, h('i', { style: { width: `${Math.min(100, second.used)}%` } }))));
  }
  row.title = [src.name, ...(info?.windows || []).map((w) => `${w.label}: ${w.used}%${w.resetsAt ? ` (сброс ${relTime(w.resetsAt)})` : ''}`), info?.note, info?.source && `Источник: ${info.source}`].filter(Boolean).join('\n');
  return row;
}

export function limitsPanel() {
  const box = h('div', { class: 'limits-pop' });
  const render = () => {
    box.innerHTML = '';
    box.append(h('div', { class: 'lp-head' }, h('b', {}, 'Лимиты'), h('span', { class: 'muted' }, limits.at ? `обновлено ${relTime(limits.at)}` : 'загрузка…'),
      h('button', { class: 'icon-btn sm', title: 'Обновить', html: icon('refresh', 13), onclick: () => limits.refresh() })));
    const keys = Object.keys(limits.data);
    for (const k of keys) box.append(limitRow(k, limits.data[k]));
    box.append(h('div', { class: 'lp-foot muted' }, 'Codex — из сессий ~/.codex, Claude Code — из аккаунта, API — по ключам и заголовкам. Суточный бюджет токенов можно задать в Настройках.'));
  };
  render();
  const off = limits.on('change', render);
  return { el: box, destroy: off };
}

// ---------------- pet ----------------
function gugagagaSvg(mood = 'idle') {
  // «Гугагага» — original baby creature in a soft dino hood
  const eyes = mood === 'busy'
    ? '<path d="M39 56 q5 -7 10 0" stroke="#3b2b47" stroke-width="3.4" fill="none" stroke-linecap="round"/><path d="M61 56 q5 -7 10 0" stroke="#3b2b47" stroke-width="3.4" fill="none" stroke-linecap="round"/>'
    : mood === 'sleep'
      ? '<path d="M39 57 q5 4 10 0" stroke="#3b2b47" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M61 57 q5 4 10 0" stroke="#3b2b47" stroke-width="3" fill="none" stroke-linecap="round"/>'
      : '<g class="pet-eyes"><ellipse cx="44" cy="56" rx="6" ry="7" fill="#3b2b47"/><ellipse cx="66" cy="56" rx="6" ry="7" fill="#3b2b47"/><circle cx="46.5" cy="53" r="2.3" fill="#fff"/><circle cx="68.5" cy="53" r="2.3" fill="#fff"/><circle cx="42" cy="59" r="1.1" fill="#fff"/><circle cx="64" cy="59" r="1.1" fill="#fff"/></g>';
  const mouth = mood === 'busy'
    ? '<ellipse cx="55" cy="72" rx="5" ry="4.2" fill="#c2456a"/><ellipse cx="55" cy="73.6" rx="3" ry="1.8" fill="#ff8fa8"/>'
    : mood === 'sleep'
      ? '<path d="M51 71 q4 3 8 0" stroke="#3b2b47" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="66" cy="74" r="3.6" fill="#cfeaff" stroke="#8fc0e8" stroke-width="1"/>'
      : '<circle cx="55" cy="73" r="7.5" fill="#ff9cb5" stroke="#3b2b47" stroke-width="2"/><rect x="51" y="70.5" width="8" height="5" rx="2.5" fill="#ffd36e" stroke="#3b2b47" stroke-width="1.4"/><circle cx="55" cy="82.5" r="3.2" fill="none" stroke="#3b2b47" stroke-width="1.8"/>';
  return `<svg viewBox="0 0 110 100" class="pet-svg ${mood}">
    <path d="M40 16 q6 -10 12 0 M52 12 q6 -11 12 0 M64 16 q6 -9 11 1" fill="#7fd6ad" stroke="#3b2b47" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M18 92 C14 50 30 18 55 18 C80 18 96 50 92 92 Z" fill="#9fe3c2" stroke="#3b2b47" stroke-width="2.6" stroke-linejoin="round"/>
    <ellipse cx="55" cy="62" rx="27" ry="25" fill="#ffd6bd" stroke="#3b2b47" stroke-width="2.4"/>
    <path d="M47 39 q4 -6 8 -1" stroke="#3b2b47" stroke-width="2" fill="none" stroke-linecap="round"/>
    ${eyes}
    <ellipse cx="35" cy="67" rx="5.5" ry="3.4" fill="#ff9fb4" opacity=".75"/><ellipse cx="75" cy="67" rx="5.5" ry="3.4" fill="#ff9fb4" opacity=".75"/>
    ${mouth}
    <ellipse cx="17" cy="78" rx="7" ry="6" fill="#9fe3c2" stroke="#3b2b47" stroke-width="2.4" class="pet-arm-l"/>
    <ellipse cx="93" cy="78" rx="7" ry="6" fill="#9fe3c2" stroke="#3b2b47" stroke-width="2.4" class="pet-arm-r"/>
    ${mood === 'busy' ? '<path d="M94 30 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2 z" fill="#ffd36e"/><path d="M14 36 l1.5 3.5 l3.5 1.5 l-3.5 1.5 l-1.5 3.5 l-1.5 -3.5 l-3.5 -1.5 l3.5 -1.5 z" fill="#ffd36e"/>' : ''}
    ${mood === 'sleep' ? '<text x="84" y="34" font-size="15" font-weight="800" fill="#3b2b47">z</text><text x="94" y="22" font-size="10" font-weight="800" fill="#3b2b47">z</text>' : ''}
  </svg>`;
}

// Original chibi witch (own design)
function witchSvg(mood = 'idle') {
  const eyes = mood === 'busy'
    ? '<path d="M40 60 q5 -6 10 0" stroke="#3a2a4a" stroke-width="3.2" fill="none" stroke-linecap="round"/><path d="M60 60 q5 -6 10 0" stroke="#3a2a4a" stroke-width="3.2" fill="none" stroke-linecap="round"/>'
    : mood === 'sleep'
      ? '<path d="M40 61 q5 4 10 0" stroke="#3a2a4a" stroke-width="2.8" fill="none" stroke-linecap="round"/><path d="M60 61 q5 4 10 0" stroke="#3a2a4a" stroke-width="2.8" fill="none" stroke-linecap="round"/>'
      : '<g class="pet-eyes"><ellipse cx="45" cy="61" rx="5.6" ry="7" fill="#7a3fb0"/><ellipse cx="65" cy="61" rx="5.6" ry="7" fill="#7a3fb0"/><ellipse cx="45" cy="63" rx="3.4" ry="4" fill="#c27df0"/><ellipse cx="65" cy="63" rx="3.4" ry="4" fill="#c27df0"/><circle cx="47" cy="58" r="2.2" fill="#fff"/><circle cx="67" cy="58" r="2.2" fill="#fff"/></g>';
  const mouth = mood === 'busy' ? '<path d="M51 71 q4 5 8 0 z" fill="#c2456a"/>' : mood === 'sleep' ? '<path d="M52 72 q3 2 6 0" stroke="#3a2a4a" stroke-width="2" fill="none" stroke-linecap="round"/>' : '<path d="M51 71 q4 3.5 8 0" stroke="#3a2a4a" stroke-width="2.2" fill="none" stroke-linecap="round"/>';
  return `<svg viewBox="0 0 110 100" class="pet-svg ${mood}">
    <path d="M24 100 C24 84 36 78 55 78 C74 78 86 84 86 100 Z" fill="#3b3f8f" stroke="#2a2550" stroke-width="2.2"/>
    <path d="M49 79 l6 8 l6 -8" fill="#f3e9ff" stroke="#2a2550" stroke-width="1.6"/>
    <circle cx="55" cy="90" r="3.2" fill="#ffd36e" stroke="#2a2550" stroke-width="1.2"/>
    <path d="M26 60 C22 80 30 88 36 86 L38 60 Z M84 60 C88 80 80 88 74 86 L72 60 Z" fill="#cdb2ff" stroke="#2a2550" stroke-width="2"/>
    <ellipse cx="55" cy="61" rx="24" ry="21" fill="#ffe4d6" stroke="#2a2550" stroke-width="2.2"/>
    <path d="M31 56 C33 40 45 36 55 37 C65 36 77 40 79 56 C72 50 66 47 60 48 L57 53 L54 48 C46 47 38 50 31 56 Z" fill="#cdb2ff" stroke="#2a2550" stroke-width="2"/>
    ${eyes}
    <ellipse cx="38" cy="69" rx="4.6" ry="2.8" fill="#ffa3bd" opacity=".75"/><ellipse cx="72" cy="69" rx="4.6" ry="2.8" fill="#ffa3bd" opacity=".75"/>
    ${mouth}
    <path d="M18 42 Q55 30 92 42 Q90 47 55 45 Q20 47 18 42 Z" fill="#5a45c9" stroke="#2a2550" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M33 41 C38 24 48 10 62 4 C64 10 70 14 76 13 C68 20 72 30 77 40 Z" fill="#6c55e0" stroke="#2a2550" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M34 39 Q55 33 76 39 L77 43 Q55 37 34 43 Z" fill="#ffd36e" stroke="#2a2550" stroke-width="1.4"/>
    <path d="M58 22 l1.6 3.6 l3.8 .4 l-2.9 2.5 l.9 3.8 l-3.4 -2 l-3.4 2 l.9 -3.8 l-2.9 -2.5 l3.8 -.4 z" fill="#ffd36e"/>
    <g class="pet-arm-r"><path d="M84 84 l14 -22" stroke="#6b4a2b" stroke-width="3" stroke-linecap="round"/><path d="M98 55 l1.8 4 l4.2 .4 l-3.2 2.8 l1 4.2 l-3.8 -2.2 l-3.8 2.2 l1 -4.2 l-3.2 -2.8 l4.2 -.4 z" fill="#ffd36e" stroke="#c99a2e" stroke-width=".8"/></g>
    ${mood === 'busy' ? '<circle cx="90" cy="46" r="2" fill="#ffd36e"/><circle cx="104" cy="48" r="1.6" fill="#ffd36e"/><circle cx="96" cy="40" r="1.3" fill="#fff"/>' : ''}
    ${mood === 'sleep' ? '<text x="86" y="30" font-size="14" font-weight="800" fill="#2a2550">z</text><text x="96" y="20" font-size="10" font-weight="800" fill="#2a2550">z</text>' : ''}
  </svg>`;
}

export const PETS = {
  blondie: { name: 'Блонди', bg: 'linear-gradient(160deg, #fff1d6, #ffd9e2)', images: { idle: 'assets/pets/blondie-idle.png', busy: 'assets/pets/blondie-busy.png', sleep: 'assets/pets/blondie-sleep.png' },
    lines: {
      busy: ['Агенты работают, я болею за них!', 'Ура, код пишется ✨', 'Слежу за лимитами, всё под контролем'],
      idle: ['Агенты ждут задачу — дадим?', 'Привет! Чем займёмся?', 'Перетащи заметку на canvas, будет контекст'],
      none: ['Позовём агента? Кнопки в доке 👉', 'Тут пусто… запустим Claude или Codex?'],
    } },
  gugagaga: { name: 'Гугагага', bg: 'linear-gradient(160deg, #ffd9e6, #d9cbff)', svg: gugagagaSvg,
    lines: {
      busy: ['Гу-га-га! Агенты пашут!', 'Гугагага… тсс, они пишут код', 'Га! Слежу за лимитами'],
      idle: ['Гу? Все агенты ждут задачу', 'Га-га! Дай им работу', 'Гугагага! Перетащи заметку на canvas'],
      none: ['Гу-гу… нажми кнопку в доке, позовём агента', 'Га? Пусто. Запустим Claude или Codex?'],
    } },
  fox: { name: 'Лисёнок', bg: 'linear-gradient(160deg, #ffe6cc, #ffd0b5)', images: { idle: 'assets/pets/fox.png' },
    lines: { busy: ['Фыр! Агенты пашут', 'Хвостом машу — код пишется ✨', 'Слежу за лимитами'], idle: ['Фыр? Агенты ждут задачу', 'Дадим им работу?', 'Перетащи заметку на canvas'], none: ['Позовём агента? Кнопки в доке', 'Тут пусто… фыр'] } },
  robot: { name: 'Робот Бип', bg: 'linear-gradient(160deg, #e3e0ff, #d2f1ff)', images: { idle: 'assets/pets/robot.png' },
    lines: { busy: ['Бип-буп! Обработка задач…', 'Агенты в работе: 100% счастья', 'Мониторю лимиты ⚡'], idle: ['Бип? Жду команду', 'Агенты в режиме ожидания', 'Подключите заметку стрелкой — получу контекст'], none: ['Бип. Агентов не обнаружено', 'Запустить Codex? Бип-бип'] } },
  coder: { name: 'Кодер', bg: 'linear-gradient(160deg, #dfe7ff, #e9ddff)', images: { idle: 'assets/pets/coder.png' },
    lines: { busy: ['Агенты коммитят, я ревьюю 😎', 'Компилируем…', 'Лимиты под контролем'], idle: ['Ну что, задеплоим что-нибудь?', 'Агенты ждут тикет', 'Кинь заметку стрелкой в чат — будет контекст'], none: ['Пусто. Запускаем Claude Code?', 'Позови агента из дока'] } },
  dragon: { name: 'Дракончик', bg: 'linear-gradient(160deg, #d9f7e8, #fff1c9)', images: { idle: 'assets/pets/dragon.png' },
    lines: { busy: ['Р-р-р! Агенты жгут ✨', 'Дышу на код огнём (тёплым)', 'Стерегу лимиты как сокровище'], idle: ['Р-р? Агенты ждут задачу', 'Дай им работу!', 'Перетащи заметку на canvas'], none: ['Позовём агента? Кнопки в доке', 'Тут пусто… р-р'] } },
  axolotl: { name: 'Аксолотль', bg: 'linear-gradient(160deg, #ffe0ee, #e0f0ff)', images: { idle: 'assets/pets/axolotl.png' },
    lines: { busy: ['Агенты работают, я пью бабл-ти 🧋', 'Буль! Код пишется', 'Слежу за лимитами'], idle: ['Буль? Агенты ждут задачу', 'Дай им работу!', 'Перетащи заметку на canvas'], none: ['Позовём агента? Кнопки в доке', 'Буль… тут пусто'] } },
  witch: { name: 'Чиби-волшебница', bg: 'linear-gradient(160deg, #e6dcff, #ffe0ec)', svg: witchSvg,
    lines: {
      busy: ['Заклинание кода в процессе ✨', 'Агенты колдуют, не отвлекаю', 'Слежу за маной… то есть лимитами'],
      idle: ['Агенты ждут твоего заклинания', 'Взмахни палочкой — дай задачу!', 'Перетащи заметку на canvas — наколдую контекст'],
      none: ['Призовём агента? Кнопки в доке', 'Тут пусто… позвать Claude или Codex?'],
    } },
  custom: { name: 'Своя картинка', bg: 'linear-gradient(160deg, #e9edf5, #d9e0ee)', svg: null,
    lines: {
      busy: ['Агенты работают!', 'Идёт работа…'],
      idle: ['Агенты ждут задачу', 'Дай им работу!'],
      none: ['Позовём агента? Кнопки в доке'],
    } },
};
const CODEX_BG = 'linear-gradient(160deg, #eef1ff, #e2f3ff)';
const CODEX_LINES = { busy: ['Агенты работают — я слежу!', 'Идёт работа…'], idle: ['Агенты ждут задачу', 'Дай им работу!'], none: ['Позовём агента? Кнопки в доке'] };
export function currentPet() {
  const cp = codexPetFor(state.settings.petKind);
  if (cp) return { name: cp.displayName, bg: CODEX_BG, codex: cp, lines: CODEX_LINES };
  return PETS[state.settings.petKind] || PETS.blondie;
}
function petImg(src, mood, own) {
  // single-image pets get their mood from animation + overlay
  const fx = own ? '' : '<span class="pet-fx"></span>';
  return `<div class="pet-svg pet-wrap ${mood}${own ? ' own' : ''}"><img src="${esc(safeUrl(src, { image: true }))}" alt="" draggable="false">${fx}</div>`;
}
export function petMarkup(key, mood = 'idle') {
  const cp = codexPetFor(key);
  if (cp) return `<div class="pet-svg pet-wrap ${mood} cpet-static" style="background-image:url('${esc(safeUrl(cp.url, { image: true }))}');background-size:800% ${Number(cp.rows) * 100 || 900}%"></div>`;
  if (isCodexKind(key)) key = 'blondie';
  const p = PETS[key] || PETS.blondie;
  if (p === PETS.custom) {
    const s = state.settings;
    const src = (mood === 'busy' && s.petImageBusy) || (mood === 'sleep' && s.petImageSleep) || s.petImage;
    if (!src) return petMarkup('blondie', mood);
    const own = (mood === 'busy' && s.petImageBusy) || (mood === 'sleep' && s.petImageSleep);
    return petImg(src, mood, !!own);
  }
  if (p.images) return petImg(p.images[mood] || p.images.idle, mood, !!p.images[mood] && mood !== 'idle');
  return p.svg(mood);
}
export function petSvg(mood = 'idle') { return petMarkup(state.settings.petKind || 'blondie', mood); }

async function fileToPetImage(file) {
  const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  if (/gif/.test(file.type)) return url; // keep animated GIFs as they are
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.onerror = r; img.src = url; });
  const k = Math.min(1, 360 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
function pickFile() {
  return new Promise((resolve) => { const i = h('input', { type: 'file', accept: 'image/*' }); i.onchange = () => resolve(i.files[0] || null); i.click(); });
}

export function openPetPicker() {
  const grid = h('div', { class: 'pet-grid' });
  const codexBox = h('div', { class: 'pet-codex' });
  const customBox = h('div', { class: 'pet-custom' });
  let sprites = [];
  const select = (k) => { if (!isCodexKind(k) || !state.settings.pet) state.setSetting('pet', true); state.setSetting('petKind', k); bus.emit('pet:changed'); render(); };
  const renderCodex = () => {
    for (const sp of sprites) sp.destroy();
    sprites = [];
    const cur = state.settings.petKind || '';
    const cgrid = h('div', { class: 'pet-grid' });
    for (const p of codexPets.list) {
      const sp = new SpritePet({ url: p.url, rows: p.rows, size: 78 });
      sprites.push(sp);
      const del = h('span', { class: 'pet-del', title: 'Удалить питомца (из VibeTabula и Codex)', html: icon('x', 12), onclick: async (e) => {
        e.stopPropagation();
        if (!(await confirmBox('Удалить питомца?', `«${p.displayName}» будет удалён из ~/.codex/pets и пропадёт и из приложения Codex.`))) return;
        await native.codexPets.remove(p.id);
        if (state.settings.petKind === `codex:${p.id}`) state.setSetting('petKind', 'blondie');
        await loadCodexPets(); bus.emit('pet:changed'); renderCodex();
      } });
      const card = h('button', { class: `pet-card${cur === `codex:${p.id}` ? ' on' : ''}`, title: p.description || p.displayName, onclick: () => { select(`codex:${p.id}`); renderCodex(); } },
        h('div', { class: 'pet-prev', style: { background: CODEX_BG } }, sp.el), h('div', { class: 'pet-name' }, p.displayName), del);
      card.addEventListener('mouseenter', () => sp.play('waving', { once: true, then: 'idle' }));
      cgrid.append(card);
    }
    codexBox.replaceChildren(
      h('div', { class: 'pet-custom-head' }, h('b', {}, 'Питомцы Codex'),
        h('span', { class: 'muted small' }, 'Анимированные питомцы из приложения Codex: показывают, что делают агенты, бегают, когда их тащишь, машут и прыгают. Хранятся в ~/.codex/pets — общие с Codex.')),
      codexPets.list.length ? cgrid : h('div', { class: 'muted small pet-codex-empty' }, 'Пока нет установленных — выберите в каталоге: там больше 3500 питомцев.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => openPetCatalog(() => { loadCodexPets().then(renderCodex); }) }, h('span', { html: icon('globe', 14) }), ' Каталог codex-pets.net'),
        h('button', { class: 'btn', onclick: async () => { await loadCodexPets(); renderCodex(); } }, 'Обновить список')),
    );
  };
  const render = () => {
    const cur = state.settings.petKind || 'blondie';
    grid.innerHTML = '';
    for (const [k, p] of Object.entries(PETS)) {
      if (k === 'custom' && !state.settings.petImage) continue;
      const card = h('button', { class: `pet-card${k === cur ? ' on' : ''}`, onclick: () => select(k) });
      const prev = h('div', { class: 'pet-prev', style: { background: p.bg }, html: petMarkup(k, 'idle') });
      card.append(prev, h('div', { class: 'pet-name' }, p.name));
      grid.append(card);
    }
    customBox.innerHTML = '';
    const s = state.settings;
    const slot = (key, label) => {
      const has = !!s[key];
      const el = h('div', { class: 'pet-slot' },
        h('div', { class: 'pet-slot-img', html: has ? `<img src="${esc(safeUrl(s[key], { image: true }))}" alt="">` : icon('plus', 22) }),
        h('div', { class: 'pet-slot-label' }, label),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: async () => {
            const f = await pickFile(); if (!f) return;
            state.setSetting(key, await fileToPetImage(f));
            if (key === 'petImage') state.setSetting('petKind', 'custom');
            bus.emit('pet:changed'); render(); toast('Картинка питомца обновлена');
          } }, has ? 'Заменить' : 'Загрузить'),
          has && key !== 'petImage' ? h('button', { class: 'btn sm', onclick: () => { state.setSetting(key, null); bus.emit('pet:changed'); render(); } }, 'Убрать') : null));
      return el;
    };
    customBox.append(
      h('div', { class: 'pet-custom-head' }, h('b', {}, 'Свой питомец'), h('span', { class: 'muted small' }, 'Любая картинка (PNG с прозрачным фоном смотрится лучше всего, GIF анимируется). Картинки для «работает» и «спит» — по желанию.')),
      h('div', { class: 'pet-slots' }, slot('petImage', 'Обычный'), slot('petImageBusy', 'Агенты работают'), slot('petImageSleep', 'Агентов нет')),
    );
  };
  render();
  renderCodex();
  if (!codexPets.loaded) loadCodexPets().then(renderCodex);
  modal({ title: 'Питомец', body: h('div', {}, codexBox, h('div', { class: 'pet-custom-head' }, h('b', {}, 'Встроенные')), grid, customBox), width: 'min(820px, 94vw)', className: 'pet-modal', onClose: () => sprites.forEach((sp) => sp.destroy()) });
}

// ---------------- codex-pets.net catalog ----------------
const ipcMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export function openPetCatalog(onInstalled) {
  let page = 1, sort = 'popular', q = '', sprites = [], busy = false;
  const search = h('input', { class: 'input', placeholder: 'Поиск: кот, robot, anime…' });
  const sortSel = h('select', { class: 'select' }, ...[['popular', 'Популярные'], ['new', 'Новые'], ['views', 'Просматриваемые'], ['discussed', 'Обсуждаемые'], ['random', 'Случайные']].map(([v, l]) => h('option', { value: v }, l)));
  sortSel.value = sort;
  const grid = h('div', { class: 'cat-grid' });
  const pager = h('div', { class: 'cat-pager' });
  const status = h('div', { class: 'muted small' });
  const load = async () => {
    if (busy) return; busy = true;
    status.textContent = 'Загрузка…';
    try {
      const data = await native.codexPets.catalog({ page, pageSize: 24, sort, q });
      for (const sp of sprites) sp.destroy();
      sprites = [];
      grid.replaceChildren(...data.pets.map((p) => card(p)));
      status.textContent = `${data.total.toLocaleString('ru-RU')} питомцев · страница ${data.page} из ${data.totalPages}`;
      pager.replaceChildren(
        h('button', { class: 'btn sm', disabled: data.page <= 1, onclick: () => { page--; load(); } }, '← Назад'),
        h('button', { class: 'btn sm', disabled: data.page >= data.totalPages, onclick: () => { page++; load(); } }, 'Дальше →'));
      grid.scrollTop = 0;
    } catch (e) {
      status.textContent = `Не удалось загрузить каталог: ${ipcMsg(e)}. Проверьте интернет.`;
    }
    busy = false;
  };
  const card = (p) => {
    const sp = new SpritePet({ url: p.spritesheetUrl, rows: p.rows, size: 96, still: true });
    sprites.push(sp);
    const btn = h('button', { class: `btn sm ${p.installed ? '' : 'primary'}` }, p.installed ? 'Выбрать' : 'Установить');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = p.installed ? '…' : 'Загрузка…';
      try {
        const inst = p.installed ? { id: p.id } : await native.codexPets.install(p);
        await loadCodexPets();
        state.setSetting('pet', true);
        state.setSetting('petKind', `codex:${inst.id}`);
        bus.emit('pet:changed');
        p.installed = true; btn.textContent = 'Выбран ✓'; btn.classList.remove('primary');
        toast(`«${p.displayName}» теперь ваш питомец`);
        onInstalled?.();
      } catch (e) { btn.disabled = false; btn.textContent = 'Установить'; toast('Не удалось установить: ' + ipcMsg(e), 'error'); }
    };
    const el = h('div', { class: 'cat-card', title: p.description },
      h('div', { class: 'cat-prev' }, sp.el, p.rows === 11 ? h('span', { class: 'cat-badge', title: 'Смотрит на курсор (16 направлений)' }, '👀') : null),
      h('div', { class: 'cat-name' }, p.displayName),
      h('div', { class: 'cat-owner' }, p.owner ? `by ${p.owner}` : ''),
      btn);
    // previews come alive on hover, like on codex-pets.net
    const states = ['idle', 'waving', 'running', 'jumping', 'review'];
    let si = 0;
    el.addEventListener('mouseenter', () => { sp.setStill(false); sp.play(states[si++ % states.length]); });
    el.addEventListener('mouseleave', () => { sp.play('idle'); sp.setStill(true); });
    return el;
  };
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = search.value.trim(); page = 1; load(); }, 350); });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  sortSel.onchange = () => { sort = sortSel.value; page = 1; load(); };
  const body = h('div', { class: 'cat-wrap' },
    h('div', { class: 'cat-bar' }, search, sortSel),
    status, grid, pager,
    h('div', { class: 'muted small' }, 'Питомцы — работы сообщества с ', h('a', { href: 'https://codex-pets.net/', target: '_blank' }, 'codex-pets.net'), '. Устанавливаются в ~/.codex/pets и сразу появляются в приложении Codex.'));
  modal({ title: 'Каталог Codex Pets', body, width: 'min(1000px, 96vw)', className: 'cat-modal', onClose: () => sprites.forEach((sp) => sp.destroy()) });
  load();
  setTimeout(() => search.focus(), 50);
}

// ---------------- hub widget ----------------

export function mountHub({ node, view, body }) {
  const root = h('div', { class: 'hub' });
  const limitsBox = h('div', { class: 'hub-tile hub-limits' });
  const statusBox = h('div', { class: 'hub-tile hub-status' });
  const clock = h('div', { class: 'hub-tile hub-clock' });
  const pet = h('div', { class: 'hub-tile hub-pet', title: 'Питомец — нажмите, чтобы поиграть' });
  const paintPetBg = () => { pet.style.background = currentPet().bg; };
  paintPetBg();
  const bubble = h('div', { class: 'pet-bubble' });
  const swap = h('button', { class: 'pet-swap no-drag', title: 'Сменить питомца', html: icon('refresh', 13), onclick: (e) => { e.stopPropagation(); openPetPicker(); } });
  pet.append(bubble, swap);
  pet.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openPetPicker(); });
  const dock = h('div', { class: 'hub-dock' });
  const settingsBtn = h('button', { class: 'hub-tile hub-settings no-drag', title: 'Настройки', html: icon('settings', 20), onclick: (e) => { e.stopPropagation(); bus.emit('openSettings'); } });
  root.append(limitsBox, statusBox, clock, pet, dock, settingsBtn);
  body.append(root);

  const renderLimits = () => {
    limitsBox.innerHTML = '';
    const rows = state.settings.limitRows?.length ? state.settings.limitRows : ['codex', 'claude', 'kimi'];
    for (const k of rows.slice(0, 4)) limitsBox.append(limitRow(k, limits.data[k], { compact: true }));
    if (!limits.at) limitsBox.append(h('div', { class: 'muted small' }, 'загрузка…'));
  };
  limitsBox.addEventListener('click', (e) => { e.stopPropagation(); bus.emit('showLimits', limitsBox); });

  let tileSprite = null, agentState = 'idle';
  const offAS = bus.on('agentstate', (info) => { agentState = info.state; if (tileSprite && !tileSprite.once) tileSprite.play(info.state); else if (tileSprite) tileSprite.then = info.state; });
  const offCP = bus.on('codexPets:changed', () => { statusSig = null; renderStatus(); });
  const agentNodes = () => view.doc.nodes.filter((n) => ['terminal', 'chat', 'agentchat'].includes(n.type));
  let statusSig = '';
  const renderStatus = () => {
    const nodes = agentNodes();
    const sts = new Map(nodes.map((n) => { const v = view.views.get(n.id); return [n.id, v?.def?.status?.(n, v?.inst)]; }));
    const sig = nodes.map((n) => { const v = view.views.get(n.id); const st = sts.get(n.id); return `${n.id}:${v?.def?.title(n)}:${st?.kind}:${st?.label}`; }).join('|');
    // the same rows: only the line «what it is doing» changes (the time counts up), in place
    if (sig === statusSig && statusBox.childElementCount) {
      for (const el of statusBox.querySelectorAll('.hs-st[data-id]')) paintActivity(el, sts.get(el.dataset.id));
      return;
    }
    statusSig = sig;
    statusBox.innerHTML = '';
    if (!nodes.length) statusBox.append(h('div', { class: 'hs-empty' }, 'Нет агентов на этом canvas'));
    const order = { wait: 0, busy: 1, na: 2, idle: 3, off: 4 };
    const list = nodes.map((n) => { const v = view.views.get(n.id); const def = v?.def; return { n, def, st: sts.get(n.id) || { label: '', kind: 'off' } }; })
      .filter((x) => x.def)
      .sort((a, b) => (order[a.st.kind] ?? 9) - (order[b.st.kind] ?? 9));
    for (const { n, def, st } of list.slice(0, 3)) {
      statusBox.append(h('div', { class: `hs-row ${st.kind} no-drag`, onclick: (e) => { e.stopPropagation(); view.focusNode(n.id); } },
        def.badge(n, 14), h('div', { class: 'hs-text' }, h('div', { class: 'hs-title' }, def.title(n)), (() => { const el = h('div', { class: 'hs-st', 'data-id': n.id }); paintActivity(el, st); return el; })()),
        h('span', { class: 'hs-dot' })));
    }
    if (list.length > 3) statusBox.append(h('div', { class: 'hs-more' }, `+ ещё ${list.length - 3}`));
    const busy = list.filter((x) => x.st.kind === 'busy').length;
    const cp = codexPetFor(state.settings.petKind);
    if (cp) {
      if (!tileSprite || tileSprite.url !== cp.url) {
        tileSprite?.destroy(); pet.querySelector('.pet-svg')?.remove();
        const size = Math.round(Math.max(64, Math.min(150, (pet.clientHeight || 110) * 0.92 * 192 / 208)));
        tileSprite = new SpritePet({ url: cp.url, rows: cp.rows, size, state: agentState });
        tileSprite.el.classList.add('pet-svg');
        pet.prepend(tileSprite.el);
      }
      pet.dataset.mood = 'codex';
      return;
    }
    if (tileSprite) { tileSprite.destroy(); tileSprite = null; pet.dataset.mood = ''; }
    const mood = !list.length ? 'sleep' : busy ? 'busy' : 'idle';
    if (mood !== pet.dataset.mood) { pet.dataset.mood = mood; pet.querySelector('.pet-svg')?.remove(); pet.insertAdjacentHTML('afterbegin', petSvg(mood)); }
  };

  // StandBy-style clock: chunky rounded digits in overlapping shades of blue + date
  let clockKey = '';
  const renderClock = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    const date = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    const key = hh + mm + date;
    if (key === clockKey) return;
    clockKey = key;
    clock.innerHTML = clockMarkup(hh, mm, date);
  };
  const repaintClock = () => paintClock(clock);
  repaintClock();
  const themeObs = new MutationObserver(repaintClock);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const offClock = state.on('settings', (k) => { if (k === 'all' || String(k).startsWith('clock')) repaintClock(); });
  clock.title = 'ПКМ — цвета часов';
  clock.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const theme = isLightTheme() ? 'light' : 'dark';
    const key = theme === 'light' ? 'clockLight' : 'clockDark';
    const cur = state.settings[key] || CLOCK_DEFAULT[theme];
    const sw = (c) => `<span class="clock-sw" style="background:${c.bg}"><i style="background:${c.d[0]}"></i><i style="background:${c.d[1]}"></i></span>`;
    menu([
      { label: theme === 'light' ? 'Цвета часов для светлой темы' : 'Цвета часов для тёмной темы', disabled: true },
      ...Object.entries(CLOCK_PRESETS).map(([id, c]) => ({ label: c.name, badge: h('span', { html: sw(c) }), checked: cur === id, onClick: () => state.setSetting(key, id) })),
      '-',
      { label: 'Свои цвета…', icon: 'palette', checked: cur === 'custom', onClick: () => bus.emit('openSettings', 'general', 'clock') },
    ], e.clientX, e.clientY);
  });

  const renderDock = () => {
    dock.innerHTML = '';
    const mk = (content, title, fn, cls = '') => {
      const b = h('button', { class: `dock-btn no-drag ${cls}`, title });
      if (typeof content === 'string') b.innerHTML = content; else b.append(content);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
      return b;
    };
    dock.append(mk(icon('terminal', 18), 'Терминал', () => bus.emit('launchAgent', { agentId: 'shell', near: node.id }), 'dark'));
    for (const a of state.settings.agents.filter((x) => x.id !== 'shell' && !x.hidden).slice(0, 4)) {
      dock.append(mk(badge(a.mono, a.color, 20, a.dark), `${a.name}: окно чата или терминал`, (e) => { const r = e.currentTarget.getBoundingClientRect(); bus.emit('agentMenu', { agentId: a.id, x: r.left, y: r.bottom + 6, near: node.id }); }));
    }
    dock.append(mk(icon('sparkle', 18), 'API-чат с нейросетью', (e) => { const r = e.currentTarget.getBoundingClientRect(); bus.emit('launchChatMenu', { near: node.id, x: r.left, y: r.top }); }));
    dock.append(mk(icon('globe', 18), 'Веб-страница', () => bus.emit('launchWeb', { near: node.id })));
  };

  pet.addEventListener('click', (e) => {
    e.stopPropagation();
    const list = agentNodes();
    const busy = list.filter((n) => { const v = view.views.get(n.id); return v?.def.status?.(n, v.inst)?.kind === 'busy'; }).length;
    const L = currentPet().lines; const pool = !list.length ? L.none : busy ? L.busy : L.idle;
    const summary = list.length ? `Агентов: ${list.length}, работают: ${busy}` : '';
    bubble.innerHTML = `${esc(pool[Math.floor(Math.random() * pool.length)])}${summary ? `<br><small>${summary}</small>` : ''}`;
    bubble.classList.add('show');
    if (tileSprite) tileSprite.play('waving', { once: true, then: agentState });
    else { pet.classList.remove('wiggle'); void pet.offsetWidth; pet.classList.add('wiggle'); }
    clearTimeout(bubble._t); bubble._t = setTimeout(() => bubble.classList.remove('show'), 3200);
  });

  renderLimits(); renderClock(); renderDock(); setTimeout(renderStatus, 0);
  const offL = limits.on('change', renderLimits);
  const offA = bus.on('agents', renderStatus);
  // null, not '': with no agents on the canvas the signature itself is '' and nothing would repaint
  const offP = bus.on('pet:changed', () => { paintPetBg(); pet.dataset.mood = ''; statusSig = null; renderStatus(); });
  const offS = state.on('settings', (k) => { renderDock(); renderLimits(); if (k === 'petKind' || k === 'petImage' || k === 'all') { paintPetBg(); pet.dataset.mood = ''; statusSig = null; renderStatus(); } });
  const t1 = setInterval(renderClock, 10 * 1000);
  const t2 = setInterval(() => { if (!view.root.classList.contains('vp-moving')) renderStatus(); }, 1500);
  return {
    destroy() { offL(); offA(); offS(); offP(); offAS(); offCP(); tileSprite?.destroy(); offClock(); themeObs.disconnect(); clearInterval(t1); clearInterval(t2); },
    update() {},
  };
}
