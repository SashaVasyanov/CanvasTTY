// Errors of the agents (Codex / Claude Code CLIs) and API chats in plain words, with what to do.
//   explainError(raw, { source: 'codex' | 'claude' | 'api', name, provider, model, install, cmd, exitCode })
//   → { kind, title, hint, actions: [...], raw }
// actions: login · retry · model-auto · model · providers · limits · access · new-chat · install · terminal
// Pure function (no DOM), so it is easy to test; the chat windows render the result.

const AGENT_NAMES = { codex: 'Codex', claude: 'Claude Code' };
const VENDORS = { codex: 'OpenAI', claude: 'Anthropic' };

// "try again at 3:05 PM", "resets 5pm", "try again in 2 days 3 hours", Claude's "…limit reached|1760000000"
function whenAgain(raw) {
  const ts = /\|\s*(\d{10})\b/.exec(raw);
  if (ts) {
    const d = new Date(+ts[1] * 1000);
    const sameDay = d.toDateString() === new Date().toDateString();
    return `${sameDay ? 'сегодня' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const m = /(?:try again|available again|resets?)\s+(at|in|on)?\s*([^.\n|()]{2,40})/i.exec(raw);
  if (!m) return '';
  const what = m[2].trim().replace(/\s+/g, ' ');
  return m[1]?.toLowerCase() === 'in' ? `через ${what}` : `в ${what}`;
}

const RULES = [
  { kind: 'notfound', re: /не найдена\. Установите|command not found|is not recognized as an internal or external command|spawn \S+ ENOENT/i },
  { kind: 'nokey', re: /Нет API-ключа/i },
  { kind: 'trust', re: /Запуск отменён: программа агента не разрешена/i },
  { kind: 'quota', re: /insufficient_quota|credit balance is too low|exceeded your current quota|payment required|\b402\b|billing/i },
  { kind: 'auth', re: /\b401\b|unauthori[sz]ed|not logged in|logged out|please (?:run )?\/?log ?in|log ?in again|authentication[_ ]error|invalid (?:x-)?api[ -_]?key|incorrect api key|token (?:has )?expired|oauth token|refresh token|invalid_grant|forbidden.*key|\b403\b.*(?:key|auth)/i },
  { kind: 'limit', re: /usage limit|limit reached|hit your .{0,20}limit|rate[ _-]?limit|\b429\b|too many requests|quota exceeded/i },
  { kind: 'model', re: /model.{0,80}(?:not found|does not exist|not supported|unsupported|not available|no access|invalid|unknown)|(?:unknown|invalid|unsupported) model|issue with the selected model|model_not_found|Недопустимое значение «model»/i },
  { kind: 'context', re: /context (?:window|length)|context_length_exceeded|prompt is too long|too many tokens|maximum context|ran out of room|input is too long|request too large|\b413\b/i },
  { kind: 'overloaded', re: /overloaded|\b529\b|\b50[0234]\b|service unavailable|internal server error|server[_ ]error|bad gateway|temporarily unavailable|capacity/i },
  { kind: 'network', re: /stream disconnected|error sending request|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network|connection (?:error|reset|refused|closed)|fetch failed|timed? ?out|socket hang up|certificate|self[- ]signed|proxy/i },
  { kind: 'access', re: /sandbox|permission denied|operation not permitted|EACCES|EPERM|read-only file system|approval/i },
  { kind: 'mcp', re: /\bmcp\b/i },
  { kind: 'crash', re: /Процесс завершился с кодом|exited with code|panicked|Traceback|uncaught/i },
];

export function explainError(raw, ctx = {}) {
  raw = String(raw || '').replace(/^⚠\s*/, '').trim();
  const src = ctx.source || 'api';
  const api = src === 'api';
  const name = ctx.name || AGENT_NAMES[src] || ctx.provider || 'Сервис';
  const who = api ? (ctx.provider || 'провайдера') : VENDORS[src] || name;
  let kind = (RULES.find((r) => r.re.test(raw)) || { kind: 'other' }).kind;
  // an agent CLI that exited with an error code and an unknown message
  if (kind === 'other' && !api && ctx.exitCode != null && ctx.exitCode !== 0) kind = 'crash';
  const model = ctx.model ? ` «${ctx.model}»` : '';
  const out = (title, hint, actions) => ({ kind, title, hint, actions, raw });
  switch (kind) {
    case 'notfound':
      return out(`${name} не установлен на этом компьютере`,
        `Установите его${ctx.install ? ` командой ${ctx.install}` : ''}, один раз запустите «${ctx.cmd || src}» в терминале и войдите в аккаунт, затем нажмите «Повторить».`,
        ['install', 'retry']);
    case 'nokey':
      return out('Нет API-ключа', `Для «${ctx.provider || 'провайдера'}» не указан ключ. Добавьте его в настройках и повторите.`, ['providers', 'retry']);
    case 'trust':
      return out('Запуск не разрешён', 'Запуск программы агента был отклонён в окне подтверждения. Нажмите «Повторить» и разрешите запуск.', ['retry']);
    case 'quota':
      return api
        ? out('Закончились средства на счёте', `У «${who}» закончился баланс или лимит оплаты. Пополните счёт у провайдера или выберите другого провайдера.`, ['providers', 'retry'])
        : out('Закончились кредиты', `На аккаунте ${name} закончились кредиты. Пополните их в аккаунте ${who} или подождите обновления лимита.`, ['limits', 'retry']);
    case 'auth':
      return api
        ? out('API-ключ не подходит', `«${who}» отклонил ключ: он неверный, отозван или без доступа. Проверьте ключ в настройках.`, ['providers', 'retry'])
        : out(`Нужно войти в ${name}`, src === 'codex'
          ? 'Codex не авторизован на этом компьютере или вход устарел. «Войти» откроет терминал с codex login — войдите через браузер и нажмите «Повторить».'
          : 'Claude Code не авторизован на этом компьютере или вход устарел. «Войти» откроет Claude Code в терминале — введите /login, войдите и нажмите «Повторить».',
        ['login', 'retry']);
    case 'limit': {
      const when = whenAgain(raw);
      return api
        ? out('Слишком много запросов', `«${who}» временно ограничил запросы${when ? ` — снова можно ${when}` : ''}. Подождите немного и повторите.`, ['retry'])
        : out('Лимит подписки исчерпан', `Лимит ${name} на ближайшее время закончился${when ? `, снова можно ${when}` : ''}. Можно подождать или поручить задачу другому агенту.`, ['limits', 'retry']);
    }
    case 'model':
      return out('Модель недоступна', `Модель${model} не существует или недоступна для вашего аккаунта. ${api ? 'Укажите другую модель.' : 'Выберите «Авто» или другую модель.'}`, api ? ['model', 'retry'] : ['model-auto', 'model']);
    case 'context':
      return out('Разговор слишком длинный', 'Переписка и вложения не помещаются в память модели. Начните новый чат (этот останется в истории) или уберите большие файлы и картинки.', ['new-chat']);
    case 'overloaded':
      return out('Сервис перегружен', `Серверы ${who} сейчас не справляются с нагрузкой. Обычно это проходит за минуту-другую.`, ['retry']);
    case 'network':
      return out('Нет связи с сервером', `Не удалось связаться с ${who}. Проверьте интернет, VPN или прокси и повторите.`, ['retry']);
    case 'access':
      return out('Агенту не хватило прав', 'Агент упёрся в ограничения режима «Доступ» или прав на файлы. Выберите режим шире и повторите — или ответьте агенту, что делать.', api ? ['retry'] : ['access', 'retry']);
    case 'mcp':
      return out('Ошибка инструментов (MCP)', `Не запустился один из MCP-серверов в настройках ${name}. Проверьте их; повторите запрос.`, ['retry']);
    case 'crash':
      return out(`${name} завершился с ошибкой`, 'Подробности ниже. Повторите запрос; если ошибка повторяется, откройте сессию в терминале — там видно больше.', api ? ['retry'] : ['retry', 'terminal']);
    default:
      return out('Ошибка', '', ['retry']);
  }
}

export const ERROR_ACTIONS = {
  login: 'Войти',
  retry: 'Повторить',
  'model-auto': 'Модель «Авто»',
  model: 'Выбрать модель',
  providers: 'Настройки ключей',
  limits: 'Лимиты',
  access: 'Режим доступа',
  'new-chat': 'Новый чат',
  install: 'Скопировать команду установки',
  terminal: 'Открыть в терминале',
};
