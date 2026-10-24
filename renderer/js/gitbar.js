// Commit, pull request and CI checks in the «Изменения» card (main/gitflow.js): a strip under the
// card's head. «Закоммитить…» commits the files of this answer (only them, as they are on disk);
// «Создать PR…» makes a pull request (a new branch first when the folder is on the main branch) or
// adds the commit to the open one of this branch; the badge shows the PR's checks and «Починить»
// sends the failed ones with the end of their logs to the agent.
//   node.data.git: { commit: { hash, branch, at }, pr: { number, url, branch, base }, checks: { state, failed, at } }
import { h, icon, toast, modal } from './util.js';
import { native } from './state.js';

const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const POLL_MS = 45_000;
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export const branchFor = (title) => `agent/${String(title || '').toLowerCase().replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'changes'}`;
const firstLine = (s, n = 72) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, n) || '';

// ctx: { view, nodeId, changes(): changes, files(): paths to commit ([] when rolled back), about(): { question, answer }, toAgent(text) }
export function mountGitBar(ctx) {
  const { view, nodeId } = ctx;
  const data = () => view.node(nodeId)?.data.git || {};
  const save = (patch) => { view.setData(nodeId, { git: { ...data(), ...patch } }); paint(); };
  const root = () => ctx.changes()?.root;
  let busy = false, timer = null, alive = true;

  const status = h('span', { class: 'dg-status' });
  const prLink = h('button', { class: 'dg-pr no-drag', title: 'Открыть пул-реквест в браузере', onclick: (e) => { e.stopPropagation(); const u = data().pr?.url; if (u) native.shell.open(u); } });
  const checks = h('span', { class: 'dg-checks' });
  const refresh = h('button', { class: 'icon-btn sm no-drag', title: 'Обновить проверки', html: icon('refresh', 12), onclick: (e) => { e.stopPropagation(); readChecks(true); } });
  const fix = h('button', { class: 'btn sm primary no-drag dg-fix', title: 'Отправить агенту упавшие проверки с концом их логов', onclick: (e) => { e.stopPropagation(); fixChecks(); } }, 'Починить');
  const commitBtn = h('button', { class: 'btn sm no-drag dg-commit', onclick: (e) => { e.stopPropagation(); commitDialog(); } }, 'Закоммитить…');
  const prBtn = h('button', { class: 'btn sm no-drag dg-prbtn', onclick: (e) => { e.stopPropagation(); prDialog(); } });
  const el = h('div', { class: 'diff-git' }, h('span', { class: 'dg-ic', html: icon('branch', 13) }), status, prLink, checks, refresh, h('span', { class: 'flex' }), fix, commitBtn, prBtn);

  function paint() {
    const g = data(), pr = g.pr, c = g.checks;
    const off = !ctx.files().length;
    status.textContent = g.commit ? `✓ ${g.commit.hash}${g.commit.branch ? ` в ${g.commit.branch}` : ''}` : off ? 'изменения откачены' : 'не закоммичено';
    prLink.hidden = !pr; prLink.textContent = pr ? `PR #${pr.number}` : '';
    refresh.hidden = !pr;
    checks.hidden = !pr || !c;
    checks.className = `dg-checks ${c?.state || ''}`;
    checks.textContent = !c ? '' : c.state === 'pending' ? 'проверки идут…' : c.state === 'pass' ? 'проверки прошли' : c.state === 'none' ? 'проверок нет' : c.state === 'fail' ? `упали: ${(c.failed || []).join(', ') || 'проверки'}` : c.state === 'error' ? 'проверки не прочитаны' : '';
    checks.title = c?.error || (c?.at ? `Обновлено ${new Date(c.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '');
    fix.hidden = c?.state !== 'fail';
    status.title = g.commit ? `Коммит ${g.commit.hash}${g.commit.branch ? ` в ветке ${g.commit.branch}` : ''}` : '';
    commitBtn.hidden = !!pr; // after the PR: «Отправить в PR» commits and pushes
    commitBtn.disabled = prBtn.disabled = busy || off;
    commitBtn.title = off ? 'Изменения этого ответа откачены' : 'Закоммитить файлы этого ответа';
    prBtn.textContent = pr ? 'Отправить в PR' : 'Создать PR…';
    prBtn.title = pr ? `Закоммитить и отправить в PR #${pr.number}` : 'Пул-реквест на GitHub (нужен GitHub CLI)';
  }

  const files = () => ctx.files();
  const listOf = (fs) => h('div', { class: 'dg-files muted small' }, fs.slice(0, 8).join(', ') + (fs.length > 8 ? ` и ещё ${fs.length - 8}` : ''));
  async function work(label, job) {
    if (busy) return null;
    busy = true; paint();
    try { return await job(); } catch (e) { toast(`${label}: ${clean(e)}`, 'error', 6000); return null; } finally { busy = false; if (alive) paint(); }
  }

  function commitDialog() {
    const fs = files();
    if (!fs.length || !root()) return;
    const { question } = ctx.about();
    const ta = h('textarea', { class: 'input dg-msg', rows: 4 });
    ta.value = firstLine(question) || 'Изменения агента';
    modal({
      title: 'Коммит изменений агента', width: 520,
      body: h('div', { class: 'dg-form' },
        h('label', { class: 'set-label' }, 'Сообщение коммита'), ta,
        h('div', { class: 'muted small' }, `Файлы этого ответа (${fs.length}), как они лежат на диске сейчас. Остальное в папке и то, что вы сами добавили в индекс, не трогается.`),
        listOf(fs)),
      actions: [{ label: 'Отмена' }, { label: 'Закоммитить', primary: true, onClick: () => { const message = ta.value.trim(); if (!message) { ta.focus(); return false; } doCommit(message); return true; } }],
    });
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
  }
  async function doCommit(message) {
    const r = await work('Коммит', () => native.git.commit({ root: root(), files: files(), message }));
    if (!r) return;
    save({ commit: { hash: r.hash, branch: r.branch, at: Date.now() } });
    toast(`Закоммичено: ${r.hash}${r.branch ? ` в ${r.branch}` : ''}`, 'ok');
  }

  async function prDialog() {
    const fs = files();
    if (!fs.length || !root()) return;
    const info = await work('Пул-реквест', () => native.git.info(root()));
    if (!info) return;
    const why = !info.git ? 'Папка не в git-репозитории или недоступна на этом компьютере.'
      : !info.remote ? 'У репозитория нет удалённого репозитория (remote) — PR некуда отправить. Добавьте его: git remote add origin <адрес>.'
        : info.gh === 'missing' ? 'Для пул-реквестов нужен GitHub CLI (gh). Установите его с cli.github.com, затем один раз выполните в терминале gh auth login.'
          : info.gh === 'login' ? 'GitHub CLI не вошёл в аккаунт: выполните в терминале gh auth login и повторите.'
            : !info.branch ? 'В папке не выбрана ветка (detached HEAD) — переключитесь на ветку и повторите.' : '';
    if (why) { modal({ title: 'Пул-реквест не создать', width: 460, body: h('p', {}, why), actions: [{ label: 'Понятно', primary: true }] }); return; }
    const { question, answer } = ctx.about();
    const g = data();
    const committed = !!g.commit;
    const msg = h('textarea', { class: 'input dg-msg', rows: 3 });
    msg.value = firstLine(question) || 'Изменения агента';
    if (info.pr) {
      modal({
        title: `Отправить в PR #${info.pr.number}`, width: 520,
        body: h('div', { class: 'dg-form' },
          h('p', {}, `Ветка «${info.branch}» уже в пул-реквесте #${info.pr.number}. ${committed ? 'Коммит будет отправлен туда.' : 'Файлы этого ответа будут закоммичены и отправлены туда.'}`),
          committed ? null : h('label', { class: 'set-label' }, 'Сообщение коммита'), committed ? null : msg, committed ? null : listOf(fs)),
        actions: [{ label: 'Отмена' }, { label: 'Отправить', primary: true, onClick: () => { doPr({ title: msg.value.trim() || 'Изменения агента', body: '', commit: committed ? null : { files: fs, message: msg.value.trim() || 'Изменения агента' } }); return true; } }],
      });
      return;
    }
    const title = h('input', { class: 'input', value: firstLine(question) || 'Изменения агента' });
    const body = h('textarea', { class: 'input dg-body', rows: 6 });
    body.value = [String(answer || '').trim().slice(0, 1500), '', `Файлы: ${fs.slice(0, 20).join(', ')}${fs.length > 20 ? ' …' : ''}`, '', '_Сделано агентом в VibeTabula._'].join('\n').trim();
    const onMain = info.branch === info.defaultBranch;
    const branch = h('input', { class: 'input', value: branchFor(title.value) });
    let touched = false;
    branch.addEventListener('input', () => { touched = true; });
    title.addEventListener('input', () => { if (!touched) branch.value = branchFor(title.value); });
    modal({
      title: 'Новый пул-реквест', width: 560,
      body: h('div', { class: 'dg-form' },
        h('label', { class: 'set-label' }, 'Название'), title,
        h('label', { class: 'set-label' }, 'Описание'), body,
        onMain ? h('label', { class: 'set-label' }, 'Новая ветка') : null, onMain ? branch : null,
        h('div', { class: 'muted small' }, onMain
          ? `Сейчас папка на основной ветке «${info.branch}». Она переключится на новую ветку; ваши незакоммиченные правки останутся в папке, «${info.branch}» не изменится.`
          : `Из ветки «${info.branch}» в «${info.defaultBranch || 'main'}».`),
        h('div', { class: 'muted small' }, committed ? 'Коммит этого ответа уже сделан — ветка будет отправлена на GitHub.' : `Перед этим — коммит файлов этого ответа (${fs.length}) с названием PR.`)),
      actions: [{ label: 'Отмена' }, { label: 'Создать PR', primary: true, onClick: () => {
        const t = title.value.trim();
        if (!t) { title.focus(); return false; }
        if (onMain && !branch.value.trim()) { branch.focus(); return false; }
        doPr({ title: t, body: body.value, branch: onMain ? branch.value.trim() : '', commit: committed ? null : { files: fs, message: t } });
        return true;
      } }],
    });
    setTimeout(() => title.focus(), 0);
  }
  async function doPr(o) {
    toast('Отправляю на GitHub…', 'info', 2000);
    const r = await work('Пул-реквест', () => native.git.pr({ root: root(), ...o }));
    if (!r) return;
    save({ pr: { number: r.number, url: r.url, branch: r.branch, base: r.base, at: Date.now() }, checks: null, ...(r.commit ? { commit: { hash: r.commit.hash, branch: r.commit.branch, at: Date.now() } } : {}) });
    toast(r.existing ? `Отправлено в PR #${r.number}` : `Пул-реквест #${r.number} создан`, 'ok');
    readChecks(true);
  }

  async function readChecks(now = false) {
    clearTimeout(timer);
    const pr = data().pr;
    if (!alive || !pr || !root()) return;
    if (!now && document.hidden) { timer = setTimeout(readChecks, POLL_MS); return; }
    let c;
    try { c = await native.git.checks({ root: root(), number: pr.number }); } catch (e) { c = { state: 'error', error: clean(e), checks: [] }; }
    if (!alive) return;
    const before = data().checks?.state;
    save({ checks: { state: c.state, failed: (c.checks || []).filter((x) => x.bucket === 'fail').map((x) => x.name).slice(0, 6), at: Date.now(), ...(c.error ? { error: c.error } : {}) } });
    if (before === 'pending' && c.state === 'fail') toast(`Проверки в PR #${pr.number} упали — «Починить» отправит их агенту`, 'warn', 6000);
    // checks that have just started may not be listed yet: keep looking for a while
    if (c.state === 'pending' || (c.state === 'none' && Date.now() - (data().pr?.at || 0) < 10 * 60_000)) timer = setTimeout(readChecks, POLL_MS);
  }

  async function fixChecks() {
    const pr = data().pr;
    if (!pr) return;
    const logs = await work('Логи проверок', () => native.git.failedLogs({ root: root(), number: pr.number }));
    if (logs == null) return;
    const failed = data().checks?.failed || [];
    const text = [
      `Проверки CI в пул-реквесте #${pr.number} упали${failed.length ? `: ${failed.join(', ')}` : ''}.`,
      logs ? `\nКонец логов упавших шагов:\n\`\`\`\n${logs}\n\`\`\`` : `\nЛоги получить не удалось — посмотри их сам: ${pr.url}/checks`,
      '\nПочини, пожалуйста. Исправление я отправлю в тот же PR.',
    ].join('\n');
    ctx.toAgent(text);
  }

  paint();
  if (data().pr && data().checks?.state !== 'pass' && data().checks?.state !== 'fail') readChecks(true);
  return { el, paint, destroy: () => { alive = false; clearTimeout(timer); } };
}
