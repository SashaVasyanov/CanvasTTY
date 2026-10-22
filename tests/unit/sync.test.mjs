// Sync between computers (main/sync.js): the three-way merge of canvases and a whole round trip
// of two "computers" sharing one cloud folder (both are SyncManager instances on temp folders).
// The renderer has its own copy of the merge (renderer/js/merge.js); both must agree.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mergeDocs as mergeDocsRenderer } from '../../renderer/js/merge.js';

const require = createRequire(import.meta.url);
const { SyncManager, mergeDocs } = require('../../main/sync.js');
process.setMaxListeners(50); // every writable HistoryStore adds an "exit" listener
const { HistoryStore } = require('../../main/history.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`не дождались: ${what}`);
    await sleep(20);
  }
}

const sticky = (id, text, extra = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 200, h: 200, z: 1, data: { text }, ...extra });
const doc = (nodes, more = {}) => ({ id: 'c1', version: 1, nodes, edges: [], comments: [], ...more });
const texts = (d) => d.nodes.map((n) => n.data.text).sort();
const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

// both copies of the merge, so a difference between them shows up in every scenario
const MERGES = [['main/sync.js', mergeDocs], ['renderer/js/merge.js', mergeDocsRenderer]];

describe('mergeDocs: слияние canvas по объектам', () => {
  const base = doc([sticky('a', 'A'), sticky('b', 'B'), sticky('c', 'C')]);
  for (const [name, merge] of MERGES) {
    test(`${name}: правки разных объектов сохраняются обе`, () => {
      const local = doc([sticky('a', 'A local'), sticky('b', 'B'), sticky('c', 'C')]);
      const remote = doc([sticky('a', 'A'), sticky('b', 'B remote'), sticky('c', 'C')]);
      assert.deepEqual(texts(merge(base, local, remote)), ['A local', 'B remote', 'C']);
    });

    test(`${name}: один и тот же объект изменён с двух сторон — побеждает пришедшая (более поздняя) версия`, () => {
      const local = doc([sticky('a', 'A local'), sticky('b', 'B'), sticky('c', 'C')]);
      const remote = doc([sticky('a', 'A remote'), sticky('b', 'B'), sticky('c', 'C')]);
      assert.equal(byId(merge(base, local, remote).nodes).a.data.text, 'A remote');
    });

    test(`${name}: удаление синхронизируется в обе стороны, если на другой стороне объект не меняли`, () => {
      const deletedHere = merge(base, doc([sticky('a', 'A'), sticky('b', 'B')]), base);
      assert.deepEqual(texts(deletedHere), ['A', 'B'], 'удалён здесь, там без изменений — остаётся удалённым');
      const deletedThere = merge(base, base, doc([sticky('a', 'A'), sticky('c', 'C')]));
      assert.deepEqual(texts(deletedThere), ['A', 'C'], 'удалён там, здесь без изменений — удаляется');
    });

    test(`${name}: правка важнее удаления на другой стороне`, () => {
      const keptLocal = merge(base, doc([sticky('a', 'A'), sticky('b', 'B'), sticky('c', 'C edited here')]), doc([sticky('a', 'A'), sticky('b', 'B')]));
      assert.deepEqual(texts(keptLocal), ['A', 'B', 'C edited here']);
      const keptRemote = merge(base, doc([sticky('a', 'A'), sticky('b', 'B')]), doc([sticky('a', 'A'), sticky('b', 'B'), sticky('c', 'C edited there')]));
      assert.deepEqual(texts(keptRemote), ['A', 'B', 'C edited there']);
    });

    test(`${name}: новые объекты с обеих сторон, рёбра и комментарии сливаются так же`, () => {
      const b = doc([sticky('a', 'A')], { edges: [{ id: 'e1', from: 'a', to: 'a' }], comments: [{ id: 'k1', messages: [{ text: 'old' }] }] });
      const l = doc([sticky('a', 'A'), sticky('l', 'L')], { edges: [{ id: 'e1', from: 'a', to: 'a' }, { id: 'e2', from: 'a', to: 'l' }], comments: [] });
      const r = doc([sticky('a', 'A'), sticky('r', 'R')], { edges: [], comments: [{ id: 'k1', messages: [{ text: 'old' }, { text: 'reply' }] }] });
      const m = merge(b, l, r);
      assert.deepEqual(texts(m), ['A', 'L', 'R']);
      assert.deepEqual(m.edges.map((e) => e.id), ['e2'], 'e1 удалено там и не менялось здесь; e2 новое здесь');
      assert.deepEqual(m.comments.map((c) => c.messages.length), [2], 'ответ в ветке, удалённой здесь без изменений там, возвращает её');
    });

    test(`${name}: без общего предка ничего не удаляется — объединение`, () => {
      const m = merge(null, doc([sticky('a', 'A local'), sticky('l', 'L')]), doc([sticky('a', 'A remote'), sticky('r', 'R')]));
      assert.deepEqual(texts(m), ['A remote', 'L', 'R']);
    });

    test(`${name}: прочие поля документа берутся с пришедшей стороны, отсутствующие списки не ломают слияние`, () => {
      const m = merge(undefined, { id: 'c1', viewport: { x: 1 }, nodes: [sticky('a', 'A')] }, { id: 'c1', groups: 1 });
      assert.deepEqual(m.viewport, { x: 1 });
      assert.equal(m.groups, 1);
      assert.deepEqual(texts(m), ['A']);
      assert.deepEqual(m.edges, []);
      assert.deepEqual(m.comments, []);
    });
  }

  test('обе копии слияния дают одинаковый результат', () => {
    const b = doc([sticky('a', 'A'), sticky('b', 'B'), sticky('c', 'C'), sticky('d', 'D')]);
    const l = doc([sticky('d', 'D'), sticky('a', 'A1'), sticky('c', 'C'), sticky('x', 'X')]);
    const r = doc([sticky('b', 'B2'), sticky('a', 'A2'), sticky('y', 'Y')]);
    for (const args of [[b, l, r], [null, l, r], [b, r, l], [b, b, b]]) assert.deepEqual(mergeDocs(...args), mergeDocsRenderer(...args));
  });

  // BUG: merge.js says "keep the remote order, then local additions", but objects present on both
  // sides get the local index (the order Map is built from [...remote, ...local], later keys win),
  // so objects only the remote has jump to the front. The merged canvas then differs from the
  // remote one by order alone, which makes the computers send it back and forth (see below).
  test('порядок: сначала порядок пришедшей стороны, потом новые локальные объекты', { todo: 'общие объекты остаются в локальном порядке, вопреки комментарию в merge.js' }, () => {
    const b = doc([sticky('a', 'A'), sticky('b', 'B')]);
    const m = mergeDocs(b, doc([sticky('a', 'A'), sticky('b', 'B'), sticky('l', 'L')]), doc([sticky('b', 'B'), sticky('a', 'A')]));
    assert.deepEqual(m.nodes.map((n) => n.id), ['b', 'a', 'l']);
  });
});

// ---------------- two computers and a cloud folder ----------------
describe('SyncManager: два компьютера через общую папку', () => {
  let tmp, cloud, devices;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-sync-'));
    cloud = path.join(tmp, 'cloud');
    fs.mkdirSync(cloud);
    devices = [];
  });
  afterEach(async () => {
    for (const d of devices) d.sync.stop();
    await sleep(400); // pending state / index writes
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

  // a computer with its workspace, canvases and chats on disk
  function device(name, { ws, canvases = {}, chats = [] }) {
    const userData = path.join(tmp, name);
    const wsFile = path.join(userData, 'workspace.json');
    const canvasDir = path.join(userData, 'canvases');
    writeJson(wsFile, ws);
    fs.mkdirSync(canvasDir, { recursive: true });
    for (const [id, d] of Object.entries(canvases)) writeJson(path.join(canvasDir, `${id}.json`), d);
    const history = new HistoryStore(path.join(userData, 'chats'));
    for (const c of chats) fs.writeFileSync(history.file(c.id), JSON.stringify(c)), history.indexRecord(c, false);
    const events = [];
    const sync = new SyncManager({ userData, wsFile, canvasDir, history, send: (ch, p) => events.push([ch, p]) });
    sync.cfg = { enabled: true, dir: cloud, keys: false };
    const d = {
      name, sync, history, events, wsFile,
      ws: () => readJson(wsFile),
      canvas: (id) => readJson(path.join(canvasDir, `${id}.json`)),
      hasCanvas: (id) => fs.existsSync(path.join(canvasDir, `${id}.json`)),
      // take what is in the folder; a merged version this computer sends back goes out 50 ms
      // later (setTimeout in apply), so give it time before the next step
      async pull() { await sync.pull(); await sleep(150); },
      // the app saved a canvas / the workspace: write it and tell the sync manager
      async edit(id, fn) { const c = d.canvas(id); fn(c); writeJson(path.join(canvasDir, `${id}.json`), c); await sleep(3); await sync.localChanged('canvas', id, c); },
      async editWs(fn) { const w = d.ws(); fn(w); writeJson(wsFile, w); await sleep(3); await sync.localChanged('workspace', 'workspace', w); },
    };
    devices.push(d);
    return d;
  }
  const project = (id, name, canvases, cwd) => ({ id, name, color: 'blue', cwd, canvases: canvases.map((c) => ({ id: c, name: 'Главный' })) });
  const settings = (vaultPath, key) => ({ vaultPath, theme: 'dark', providers: { openai: { key, model: 'gpt-5' } } });
  const remoteFile = (...p) => path.join(cloud, 'VibeTabula Sync', ...p);

  function computerA(nodes = [sticky('s1', 'Привет с A')]) {
    return device('devA', {
      ws: { version: 1, projects: [project('pA', 'Проект A', ['c1'], '/work/a')], activeProjectId: 'pA', activeCanvasId: 'c1', settings: settings('/vaults/a', 'sk-A') },
      canvases: { c1: doc(nodes, { viewport: { x: 10, y: 20, z: 0.5 } }) },
      chats: [{ id: 'cv_a', kind: 'agentchat', agent: 'claude', title: 'чат с A', created: 1, updated: 2, messages: [{ role: 'user', content: 'чат с A' }, { role: 'assistant', content: 'ок' }] }],
    });
  }
  // a fresh install: one empty project, its canvas holds only the hub
  function freshB() {
    return device('devB', {
      ws: { version: 1, projects: [project('pB', 'Мой проект', ['cB'], '/home/b')], activeProjectId: 'pB', activeCanvasId: 'cB', settings: settings('/vaults/b', 'sk-B') },
      canvases: { cB: doc([{ id: 'hub', type: 'hub', x: 0, y: 0, w: 540, h: 320, data: {} }], { id: 'cB' }) },
    });
  }
  // A pushes everything, B joins
  async function joined(nodes) {
    const A = computerA(nodes);
    await A.sync.reconcile();
    const B = freshB();
    await B.sync.reconcile();
    await sleep(150);
    return { A, B };
  }

  test('первый компьютер выкладывает проекты, canvas и чаты без своих путей и ключей', async () => {
    const A = computerA();
    await A.sync.reconcile();
    const ws = readJson(remoteFile('workspace.json'));
    assert.equal(ws.kind, 'workspace');
    assert.deepEqual(ws.data.projects.map((p) => p.name), ['Проект A']);
    assert.equal(ws.data.projects[0].cwd, undefined, 'рабочие папки у каждого компьютера свои');
    assert.equal(ws.data.settings.vaultPath, undefined, 'путь к хранилищу свой');
    assert.equal(ws.data.settings.providers, undefined, 'API-ключи не уходят, пока не включены');
    assert.equal(ws.data.activeProjectId, undefined);
    const c1 = readJson(remoteFile('canvases', 'c1.json'));
    assert.deepEqual(texts(c1.data), ['Привет с A']);
    assert.equal(c1.data.viewport, undefined, 'положение и масштаб canvas свои');
    assert.equal(c1.parent, null);
    assert.equal(readJson(remoteFile('chats', 'cv_a.json')).data.title, 'чат с A');
    assert.equal(A.sync.info().status.state, 'ok');
    assert.ok(A.sync.status.pushed >= 3);
  });

  test('ключи синхронизируются, только если это включено', async () => {
    const A = computerA();
    A.sync.cfg.keys = true;
    await A.sync.reconcile();
    assert.deepEqual(readJson(remoteFile('workspace.json')).data.settings.providers, { openai: { key: 'sk-A', model: 'gpt-5' } });
  });

  test('новый компьютер просто получает всё из папки, оставляя свои пути и ключи', async () => {
    const { B } = await joined();
    const ws = B.ws();
    assert.deepEqual(ws.projects.map((p) => p.name), ['Проект A'], 'пустой проект нового компьютера не добавляется');
    assert.equal(ws.projects[0].cwd, os.homedir());
    assert.equal(ws.settings.vaultPath, '/vaults/b');
    assert.deepEqual(ws.settings.providers, { openai: { key: 'sk-B', model: 'gpt-5' } });
    assert.equal(ws.activeProjectId, 'pA');
    assert.equal(ws.activeCanvasId, 'c1');
    assert.deepEqual(texts(B.canvas('c1')), ['Привет с A']);
    assert.deepEqual(B.canvas('c1').viewport, { x: 0, y: 0, z: 1 });
    assert.deepEqual(B.history.list({}).map((r) => r.title), ['чат с A']);
    assert.ok(B.events.some(([ch, p]) => ch === 'sync:changed' && p.kind === 'canvas' && p.id === 'c1'));
    assert.equal(fs.existsSync(remoteFile('canvases', 'cB.json')), false, 'пустой canvas нового компьютера не выкладывается');
  });

  test('правка на одном компьютере приходит на другой', async () => {
    const { A, B } = await joined();
    await B.edit('c1', (c) => c.nodes.push(sticky('s2', 'Ответ с B')));
    const env = readJson(remoteFile('canvases', 'c1.json'));
    assert.equal(env.parent, readJson(remoteFile('canvases', 'c1.json')).parent);
    await A.pull();
    assert.deepEqual(texts(A.canvas('c1')), ['Ответ с B', 'Привет с A']);
    assert.deepEqual(A.canvas('c1').viewport, { x: 10, y: 20, z: 0.5 }, 'своё положение canvas не меняется');
    const ev = A.events.findLast(([ch, p]) => ch === 'sync:changed' && p.kind === 'canvas');
    assert.ok(ev[1].base && ev[1].remote, 'окну приложения передаются общий предок и пришедшая версия для слияния на лету');
  });

  test('новый проект с другого компьютера появляется, свои проекты остаются', async () => {
    const { A, B } = await joined();
    await A.editWs((w) => w.projects.push(project('pA2', 'Ещё проект A', ['c2'], '/work/a2')));
    await B.editWs((w) => w.projects.push(project('pB2', 'Проект B', ['c3'], '/work/b2')));
    await A.pull();
    assert.deepEqual(A.ws().projects.map((p) => p.name).sort(), ['Ещё проект A', 'Проект A', 'Проект B']);
    assert.equal(A.ws().projects.find((p) => p.id === 'pA').cwd, '/work/a', 'рабочая папка своего проекта сохраняется');
    // A had a project the folder did not know: it goes back
    await waitFor(() => readJson(remoteFile('workspace.json')).data.projects.length === 3, 'A возвращает объединённый список');
    await B.pull();
    assert.deepEqual(B.ws().projects.map((p) => p.name).sort(), ['Ещё проект A', 'Проект A', 'Проект B']);
  });

  test('одновременные правки одного canvas объединяются, удаление тоже доходит', async () => {
    const { A, B } = await joined();
    await B.edit('c1', (c) => c.nodes.push(sticky('s2', 'Ответ с B')));
    await A.pull();
    // both edit before seeing the other's change; B writes last and overwrites the file in the folder
    await A.edit('c1', (c) => c.nodes.push(sticky('s3', 'A одновременно')));
    await B.edit('c1', (c) => { c.nodes.push(sticky('s4', 'B одновременно')); c.nodes = c.nodes.filter((n) => n.id !== 's2'); });
    await A.pull();
    assert.deepEqual(texts(A.canvas('c1')), ['A одновременно', 'B одновременно', 'Привет с A']);
    await waitFor(() => readJson(remoteFile('canvases', 'c1.json')).device === A.sync.st.deviceId, 'A отправляет объединённую версию');
    await B.pull();
    assert.deepEqual(texts(B.canvas('c1')), ['A одновременно', 'B одновременно', 'Привет с A']);
  });

  const setText = (id, text) => (c) => { c.nodes.find((n) => n.id === id).data.text = text; };

  test('общий предок из истории версий: правка со старой версии не откатывает новую', async () => {
    const { A, B } = await joined([sticky('s1', 'Привет с A'), sticky('s4', 'B одновременно')]);
    await A.edit('c1', setText('s1', 'Привет v2'));
    await B.pull();
    assert.deepEqual(texts(B.canvas('c1')), ['B одновременно', 'Привет v2']);
    // A edits the same sticky again while B edits another one, starting from the version with v2
    await A.edit('c1', setText('s1', 'Привет v3'));
    await B.edit('c1', setText('s4', 'B v2'));
    assert.equal(readJson(remoteFile('canvases', 'c1.json')).device, B.sync.st.deviceId, 'в папке сейчас версия B (без v3)');
    await A.pull();
    assert.deepEqual(texts(A.canvas('c1')), ['B v2', 'Привет v3'], 'у A не откатилось «Привет v3»');
    assert.equal(readJson(remoteFile('canvases', 'c1.json')).device, A.sync.st.deviceId, 'A отправил объединённую версию');
    await B.pull();
    assert.deepEqual(texts(B.canvas('c1')), ['B v2', 'Привет v3']);
  });

  // BUG: when the version B edited from is unknown to A (here: B's own re-sent copy, which A never
  // pulled because A's next edit overwrote it in the folder), apply() falls back to "the last version
  // we synced" — A's own latest push. A's newest edit then counts as already known to B, B's older
  // value wins and A's edit is reverted. In this scenario B re-sends because of the order bug above.
  test('правка со старой версии не откатывает новую, даже если её версия неизвестна', { todo: 'запасной общий предок — своя последняя отправка: откат «Привет v3»' }, async () => {
    const { A, B } = await joined();
    await A.edit('c1', (c) => c.nodes.push(sticky('s4', 'B одновременно')));
    await B.pull(); // B merges s4 in its own order and sends that copy back
    await A.edit('c1', setText('s1', 'Привет v2'));
    await B.pull();
    await A.edit('c1', setText('s1', 'Привет v3'));
    await B.edit('c1', setText('s4', 'B v2'));
    await A.pull();
    assert.deepEqual(texts(A.canvas('c1')), ['B v2', 'Привет v3']);
  });

  test('удаление canvas и проекта доходит до другого компьютера и не воскресает', async () => {
    const { A, B } = await joined();
    await A.editWs((w) => { w.projects.push(project('pX', 'Удалить', ['cX'], '/x')); });
    await B.pull();
    assert.ok(B.ws().projects.some((p) => p.id === 'pX'));
    // A deletes it: tombstones travel with the workspace, the canvas file is marked deleted
    await A.editWs((w) => { w.projects = w.projects.filter((p) => p.id !== 'pX'); w.tombstones = ['pX', 'cX']; });
    await A.sync.localDeleted('canvas', 'cX');
    fs.writeFileSync(path.join(tmp, 'devB', 'canvases', 'cX.json'), JSON.stringify(doc([], { id: 'cX' })));
    await B.pull();
    assert.equal(B.ws().projects.some((p) => p.id === 'pX'), false);
    assert.equal(B.hasCanvas('cX'), false);
    assert.ok(B.ws().tombstones.includes('pX'));
    // B still lists the project in its own (older) copy: merging does not bring it back
    assert.deepEqual(B.sync.mergeWorkspace({ projects: [project('pA', 'Проект A', ['c1'])], tombstones: ['pX'] }, { projects: [project('pX', 'Удалить', ['cX'])] }).projects.map((p) => p.id), ['pA']);
  });

  test('история чатов: новый чат приходит, удалённый удаляется', async () => {
    const { A, B } = await joined();
    const rec = { id: 'cv_b', kind: 'chat', agent: 'openai', title: 'чат с B', created: 5, updated: 6, messages: [{ role: 'user', content: 'чат с B' }] };
    await B.sync.localChanged('chat', 'cv_b', rec);
    await A.pull();
    assert.deepEqual(A.history.list({}).map((r) => r.title).sort(), ['чат с A', 'чат с B']);
    assert.equal((await A.history.get('cv_b')).messages[0].content, 'чат с B');
    await sleep(3);
    await B.sync.localDeleted('chat', 'cv_a');
    await A.pull();
    assert.deepEqual(A.history.list({}).map((r) => r.title), ['чат с B']);
  });

  test('свои изменения из папки не применяются повторно, а одинаковое содержимое не отправляется', async () => {
    const A = computerA();
    await A.sync.reconcile();
    const pushed = A.sync.status.pushed;
    await A.sync.localChanged('canvas', 'c1', { ...A.canvas('c1'), viewport: { x: 999, y: 0, z: 2 } });
    assert.equal(A.sync.status.pushed, pushed, 'только положение canvas — нечего отправлять');
    await A.pull();
    assert.equal(A.sync.status.pulled, 0, 'конверты этого компьютера пропускаются');
  });

  test('папка со старым названием приложения продолжает работать', async () => {
    const A = computerA();
    fs.mkdirSync(path.join(cloud, 'CanvasTTY Sync'));
    assert.equal(A.sync.root, path.join(cloud, 'CanvasTTY Sync'));
    fs.mkdirSync(path.join(cloud, 'VibeTabula Sync'));
    assert.equal(A.sync.root, path.join(cloud, 'VibeTabula Sync'), 'новая папка, если она уже есть');
    A.sync.cfg.dir = path.join(cloud, 'CanvasTTY Sync');
    assert.equal(A.sync.root, path.join(cloud, 'CanvasTTY Sync'), 'выбрана сама папка синхронизации');
    A.sync.cfg.enabled = false;
    assert.equal(A.sync.on, false);
    await A.sync.localChanged('canvas', 'c1', A.canvas('c1'));
    assert.equal(A.sync.status.pushed, 0, 'выключенная синхронизация ничего не пишет');
  });

  // BUG: after B adds an object, A's merge puts it first ([s2, s1] instead of [s1, s2]); the hash
  // differs from B's version only by order, so A sends it back, B merges it back into its own order
  // and sends it again... every pull, forever (both computers keep rewriting the same canvas).
  test('после слияния canvas не пересылается между компьютерами по кругу', { todo: 'порядок объектов после слияния (см. тест порядка) — бесконечная пересылка' }, async () => {
    const { A, B } = await joined();
    await B.edit('c1', (c) => c.nodes.push(sticky('s2', 'Ответ с B')));
    for (let i = 0; i < 2; i++) { await A.pull(); await B.pull(); }
    const pushed = [A.sync.status.pushed, B.sync.status.pushed];
    for (let i = 0; i < 3; i++) { await A.pull(); await B.pull(); }
    assert.deepEqual([A.sync.status.pushed, B.sync.status.pushed], pushed, 'когда всё сошлось, никто ничего не отправляет');
    assert.deepEqual(texts(A.canvas('c1')), texts(B.canvas('c1')));
  });

  // BUG (race): apply() sends the merged canvas back 50 ms later with the snapshot taken at apply
  // time; a local edit pushed meanwhile is overwritten in the folder by that older version, and the
  // computer records it as synced, so other computers never get the edit.
  test('отложенная отправка объединённой версии не затирает правку, сделанную сразу после неё', { todo: 'setTimeout(localChanged(merged), 50) в apply() отправляет устаревший снимок' }, async () => {
    const { A, B } = await joined();
    await A.edit('c1', (c) => c.nodes.push(sticky('sa', 'с A')));
    await B.edit('c1', (c) => c.nodes.push(sticky('sb', 'с B'))); // B had not seen sa: the folder loses it for now
    // merged = sa + sb ≠ the folder's version → A sends it back in 50 ms; hold that timer so the
    // next edit surely falls into those 50 ms
    const realSetTimeout = globalThis.setTimeout;
    const held = [];
    globalThis.setTimeout = (fn, ms, ...args) => (ms === 50 ? (held.push(fn), 0) : realSetTimeout(fn, ms, ...args));
    try { await A.sync.pull(); } finally { globalThis.setTimeout = realSetTimeout; }
    assert.equal(held.length, 1, 'объединённая версия отправится позже');
    await A.edit('c1', (c) => c.nodes.push(sticky('sc', 'A сразу после')));
    for (const fn of held) await fn();
    await sleep(50);
    assert.deepEqual(texts(readJson(remoteFile('canvases', 'c1.json')).data), ['A сразу после', 'Привет с A', 'с A', 'с B']);
  });

  test('заметки переносятся в папку синхронизации (новые файлы копируются, служебные — нет)', async () => {
    const A = computerA();
    const vault = path.join(tmp, 'vault');
    fs.mkdirSync(path.join(vault, 'Проекты'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.trash'));
    fs.writeFileSync(path.join(vault, 'Идеи.md'), '# Идеи');
    fs.writeFileSync(path.join(vault, 'Проекты', 'План.md'), 'план');
    fs.writeFileSync(path.join(vault, '.trash', 'old.md'), 'old');
    const dest = await A.sync.adoptVault(vault);
    assert.equal(dest, remoteFile('Заметки'));
    assert.equal(fs.readFileSync(path.join(dest, 'Проекты', 'План.md'), 'utf8'), 'план');
    assert.equal(fs.existsSync(path.join(dest, '.trash')), false);
    A.sync.cfg.dir = '';
    await assert.rejects(A.sync.adoptVault(vault), /сначала выберите папку/);
  });
});
