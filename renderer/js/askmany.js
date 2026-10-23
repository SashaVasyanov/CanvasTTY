// «Спросить нескольких»: one question to 2–3 agents or models at once. They open side by side in
// an area, each gets the same question and the same canvas context; in a git folder each works in
// its own copy (git worktree), so they never edit the same files. «Выбрать этот ответ» keeps the
// best window (its copy's changes are merged into your branch), the others close — their
// conversations stay in the chat history, their copies are removed.
import { h, toast, confirmBox, modal, uid } from './util.js';
import { state, native } from './state.js';
import { NODE_TYPES, AGENT_MODELS, AGENT_MODES } from './nodes.js';
import { chatContext, imagesToAttachments } from './context.js';

const W = 460, H = 600, GAP = 30, PAD = 40;

// agents that have a chat window, each with "auto" and its models
export function askOptions() {
  const out = [];
  for (const a of state.settings.agents) {
    if (!a.chat || a.hidden) continue;
    out.push({ agentId: a.id, kind: a.chat, model: '', label: `${a.name} · авто` });
    for (const [, items] of AGENT_MODELS[a.chat] || []) for (const [v, l] of items) out.push({ agentId: a.id, kind: a.chat, model: v, label: `${a.name} · ${l}` });
  }
  return out;
}

// the dialog; sourceId: the chat window it was opened from (its folder, access mode and context)
export async function openAskMany(view, { sourceId = null, text = '' } = {}) {
  const src = sourceId ? view.node(sourceId) : null;
  const cwd = src?.data.cwd || state.project.cwd || state.info.home;
  const opts = askOptions();
  const picked = new Set();
  // two different agents by default when there are two
  const firstOf = (id) => opts.findIndex((o) => o.agentId === id && !o.model);
  for (const id of [...new Set(opts.map((o) => o.agentId))].slice(0, 2)) picked.add(firstOf(id));
  const q = h('textarea', { class: 'input ask-q', rows: 4, placeholder: 'Вопрос или задача для всех' });
  q.value = text;
  const list = h('div', { class: 'ask-list' });
  const count = h('div', { class: 'muted small ask-count' });
  const isRepo = native.wt?.isRepo ? await native.wt.isRepo(cwd).catch(() => false) : false;
  const wt = h('input', { type: 'checkbox', class: 'switch' }); wt.checked = isRepo; wt.disabled = !isRepo;
  const paint = () => {
    list.replaceChildren(...opts.map((o, i) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = picked.has(i);
      cb.disabled = !picked.has(i) && picked.size >= 3;
      cb.onchange = () => { if (cb.checked) picked.add(i); else picked.delete(i); paint(); };
      return h('label', { class: `ask-opt${picked.has(i) ? ' on' : ''}` }, cb, h('span', {}, o.label));
    }));
    count.textContent = picked.size < 2 ? 'Выберите 2 или 3 варианта' : `Выбрано: ${picked.size} из 3`;
  };
  paint();
  return new Promise((resolve) => {
    let started = false;
    modal({
      title: 'Спросить нескольких', width: 520, className: 'ask-modal',
      body: h('div', { class: 'ask-body' }, q,
        h('div', { class: 'ask-label' }, 'Кому'), list, count,
        h('label', { class: 'set-row ask-wt' }, h('div', {}, h('div', { class: 'set-label' }, 'Каждому своя копия проекта'), h('div', { class: 'muted small' }, isRepo ? 'git worktree: агенты не правят одни и те же файлы; изменения выбранного вольются в вашу ветку' : 'Папка не под git — агенты будут работать в одной папке')), wt),
        src ? h('div', { class: 'muted small' }, 'Контекст (стрелки и @) берётся из исходного окна.') : null),
      actions: [{ label: 'Отмена' }, { label: 'Спросить', primary: true, onClick: () => {
        if (!q.value.trim()) { toast('Напишите вопрос', 'warn'); return false; }
        if (picked.size < 2) { toast('Выберите хотя бы 2 варианта', 'warn'); return false; }
        const chosen = [...picked].sort((a, b) => a - b).map((i) => opts[i]);
        started = true;
        startAskMany(view, { src, cwd, text: q.value.trim(), chosen, worktrees: wt.checked && isRepo }).then(resolve, () => resolve(null));
        return true;
      } }],
      onClose: () => { if (!started) resolve(null); },
    });
    setTimeout(() => q.focus(), 50);
    q.addEventListener('keydown', (e) => e.stopPropagation());
  });
}

// the windows in an area, then the question to each; → { group, frame, ids }
export async function startAskMany(view, { src, cwd, text, chosen, worktrees }) {
  const group = uid('cmp');
  const n = chosen.length;
  const fw = PAD * 2 + n * W + (n - 1) * GAP, fh = PAD + 30 + H + PAD;
  const at = src ? { x: src.x + src.w + 80, y: src.y } : (() => { const c = view.centerWorld(); return { x: c.x - fw / 2, y: c.y - fh / 2 }; })();
  const title = `Сравнение: ${text.split('\n')[0].slice(0, 40)}`;
  const frame = view.addNode('frame', { x: at.x, y: at.y, w: fw, h: fh, data: { title } }, { center: false, select: false });
  const mode = src?.data.mode;
  const ids = chosen.map((o, i) => view.addNode('agentchat', {
    x: at.x + PAD + i * (W + GAP), y: at.y + PAD + 30, w: W, h: H,
    data: { agentId: o.agentId, kind: o.kind, model: o.model, title: o.label, messages: [], sessionId: null, cwd, ...(mode && (AGENT_MODES[o.kind] || []).some(([v]) => v === mode) ? { mode } : {}), compare: { group, frame: frame.id } },
  }, { center: false, select: false }).id);
  view.recomputeGroups?.('all');
  // the same canvas context for everyone: what the source window would send now
  let extra = '', extraLabels = [], atts = [];
  if (src) {
    try {
      const ctx = await chatContext(view, src.id, text, null);
      if (ctx.text) extra = `Контекст с canvas пользователя: объекты, соединённые с исходным чатом стрелкой или упомянутые через @${ctx.images.length ? '. Картинки из контекста приложены к сообщению' : ''}.\n\n${ctx.text}`;
      extraLabels = ctx.labels;
      if (ctx.images.length) atts = await imagesToAttachments(ctx.images);
    } catch (e) { console.warn('ask many context', e); }
  }
  for (const id of ids) {
    const inst = view.views.get(id)?.inst;
    if (!inst) continue;
    if (worktrees) {
      try {
        const w = await native.wt.create({ cwd, name: view.node(id).data.title });
        view.setData(id, { worktree: w });
        inst.node = view.node(id);
        await inst.refreshWorktree();
      } catch (e) { toast(`Копия для «${view.node(id).data.title}» не создана: ${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'warn'); }
    }
    inst.send({ text, attachments: [...atts], extra, extraLabels });
  }
  view.fit?.([frame.id]);
  return { group, frame: frame.id, ids };
}

// «Выбрать этот ответ»
export async function chooseAnswer(view, nodeId) {
  const n = view.node(nodeId);
  const g = n?.data.compare?.group, frameId = n?.data.compare?.frame;
  if (!g) return false;
  const peers = view.doc.nodes.filter((x) => x.id !== nodeId && x.data?.compare?.group === g);
  const title = NODE_TYPES.agentchat.title(n);
  const w = n.data.worktree;
  const peerCopies = peers.filter((p) => p.data.worktree).length;
  const ok = await confirmBox(`Выбрать ответ «${title}»?`, `Это окно останется${w ? ', изменения его копии вольются в вашу ветку' : ''}. ${peers.length ? `${peers.length === 1 ? 'Второе окно закроется' : `Остальные ${peers.length} окна закроются`} — переписка останется в истории чатов${peerCopies ? ', их копии проекта удалятся' : ''}.` : ''}`, 'Выбрать');
  if (!ok) return false;
  for (const p of peers) { const pi = view.views.get(p.id)?.inst; if (pi?.isBusy()) pi.stop(true); }
  const inst = view.views.get(nodeId)?.inst;
  if (inst?.isBusy()) { toast('Дождитесь, пока выбранный агент закончит', 'warn'); return false; }
  if (w) {
    let r;
    try { r = await native.wt.merge(w); } catch (e) { toast(String(e.message || e), 'error'); return false; }
    if (!r.ok) {
      modal({ title: 'Изменения не влиты', width: 460, body: h('div', {}, h('p', {}, r.reason), r.files?.length ? h('ul', { class: 'wt-files' }, ...r.files.slice(0, 20).map((f) => h('li', {}, h('code', {}, f)))) : null, h('p', { class: 'muted small' }, 'Окна остались как были: разрешите конфликт и выберите снова или влейте копию вручную из её меню.')), actions: [{ label: 'Понятно', primary: true }] });
      return false;
    }
    try { await native.wt.remove(w); } catch {}
    view.setData(nodeId, { worktree: null, sessionId: null });
  }
  for (const p of peers) {
    if (p.data.worktree) { try { await native.wt.remove(p.data.worktree, { force: true }); } catch {} }
  }
  view.removeNodes(peers.map((p) => p.id));
  view.setData(nodeId, { compare: null });
  const frame = view.node(frameId);
  if (frame) view.ungroupFrame(frame);
  if (inst) { inst.node = view.node(nodeId) || inst.node; inst.refreshWorktree?.(); inst.renderAll?.(); }
  view.select([nodeId]);
  toast(`Выбран ответ «${title}»${w ? ', изменения влиты' : ''}`, 'ok');
  return true;
}
