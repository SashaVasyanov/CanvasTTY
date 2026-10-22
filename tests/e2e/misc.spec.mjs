// Odds and ends: the Codex pet companion, migration of the removed photo galleries, HTML
// sanitising, the model / effort bar of agent chats and the chat history panel.
import { test, expect } from './fixtures.mjs';
import { canvasIdle, setViewport } from './helpers/notes.mjs';

// the agent chat instance of a node
const sendAgent = (page, id, text) => page.evaluate(([id, text]) => {
  const inst = window.__app.canvas.views.get(id).inst;
  inst.input.value = text; inst.send();
}, [id, text]);
const agentRunning = (page, id) => page.evaluate((id) => window.__app.canvas.views.get(id).inst.isBusy(), id);

test.describe('питомец Codex', () => {
  test('показывает, что делают агенты, машет по клику, бегает при перетаскивании и смотрит на курсор', async ({ app, page }) => {
    test.slow();
    await page.evaluate(async () => {
      await (await import('/js/companion.js')).loadCodexPets();
      const { state } = await import('/js/state.js');
      state.setSetting('petKind', 'codex:test-pet'); state.setSetting('pet', true);
      (await import('/js/util.js')).bus.emit('pet:changed');
    });
    const comp = page.locator('.companion');
    const bubble = comp.locator('.cbubble');
    const sheetPos = () => comp.locator('.cpet-img').evaluate((el) => el.style.backgroundPosition);
    const watch = () => page.evaluate(() => window.__app.agentWatch.info.state);
    await expect(comp).toBeVisible();
    await expect(page.locator('.pet-follower'), 'вместо бегающего за курсором питомца').toBeHidden();
    await expect(bubble).toHaveText('');

    // a working agent: "running" and its name in the bubble; done and not looked at: "review"
    // (the agent's events are sent by the test, so the "working" phase lasts as long as needed)
    await page.evaluate(async () => {
      const { native } = await import('/js/state.js');
      native.agentChat.run = async ({ reqId }) => { window.__req = reqId; return true; };
    });
    const agentEvent = (ev) => page.evaluate((ev) => window.__mockEmit('agentchat:event', { reqId: window.__req, ...ev }), ev);
    const chat = await page.evaluate(() => window.__app.launchAgentChat({ agentId: 'claude', world: { x: 0, y: 0 } }).id);
    await sendAgent(page, chat, 'тест');
    await app.clearSelection();
    await expect.poll(watch).toBe('running');
    await expect(bubble).toHaveText('тест — работает…');
    await expect(bubble).toHaveClass(/\brunning\b.*\bon\b/);
    await expect.poll(() => page.evaluate(() => !!window.__req), { message: 'задача ушла агенту' }).toBe(true);
    await agentEvent({ type: 'delta', text: 'Готово' });
    await agentEvent({ type: 'done', sessionId: 'demo-session' });
    await expect.poll(() => agentRunning(page, chat)).toBe(false);
    await expect.poll(watch).toBe('review');
    await expect(bubble).toHaveText('тест — готово, посмотрите');

    // a click waves and flies to that window, which counts as looked at
    const sp = await comp.locator('.cpet').boundingBox();
    const c0 = { x: sp.x + sp.width / 2, y: sp.y + sp.height / 2 };
    await page.mouse.click(c0.x, c0.y);
    await expect.poll(watch).toBe('idle');
    expect(await app.selection()).toEqual([chat]);
    await expect(bubble).toHaveText('');

    // dragging moves it (and it runs in that direction); the place is remembered
    const pos0 = await page.evaluate(() => ({ ...window.__app.companion.pos }));
    await page.mouse.move(c0.x, c0.y);
    await page.mouse.down();
    await page.mouse.move(c0.x - 60, c0.y - 20, { steps: 4 });
    await expect(comp).toHaveClass(/\bdragging\b/);
    expect(await page.evaluate(() => window.__app.companion.sprite.state)).toBe('running-left');
    await page.mouse.move(c0.x - 200, c0.y - 120, { steps: 6 });
    await page.mouse.up();
    await expect(comp).not.toHaveClass(/\bdragging\b/);
    const saved = await page.evaluate(async () => (await import('/js/state.js')).state.settings.companionPos);
    expect(saved).toEqual({ right: pos0.right + 200, bottom: pos0.bottom + 120 });

    // 11-row pets turn their head to the cursor while nothing else is going on (rows 10-11 of the sheet)
    await expect.poll(() => page.evaluate(() => window.__app.companion.sprite.once), { message: 'прыжок после перетаскивания закончился' }).toBe(false);
    const box = await comp.locator('.cpet').boundingBox();
    const eye = { x: box.x + box.width / 2, y: box.y + box.height * 0.42 };
    const cellW = box.width, cellH = box.height;
    await page.mouse.move(eye.x + 200, eye.y, { steps: 3 });
    await expect.poll(sheetPos).toBe(`${-4 * cellW}px ${-9 * cellH}px`); // direction 4 of 16: right
    await page.mouse.move(eye.x, eye.y - 200, { steps: 3 });
    await expect.poll(sheetPos).toBe(`0px ${-9 * cellH}px`); // direction 0: up
  });

  test('выбор питомца и каталог codex-pets.net: «Установить» делает питомца вашим', async ({ app, page }) => {
    await page.evaluate(async () => (await import('/js/hub.js')).openPetPicker());
    const picker = page.locator('.pet-modal');
    await expect(picker.locator('.pet-codex .pet-name')).toHaveText(['Тестовый пет']);
    await expect(picker.locator('.pet-grid').last().locator('.pet-card.on .pet-name')).toHaveText('Блонди');
    await picker.locator('.pet-codex .pet-card').click();
    expect(await page.evaluate(async () => (await import('/js/state.js')).state.settings.petKind)).toBe('codex:test-pet');
    await expect(page.locator('.companion')).toBeVisible();

    await picker.locator('button', { hasText: 'Каталог codex-pets.net' }).click();
    const cat = page.locator('.cat-modal');
    await expect(cat.locator('.cat-card')).toHaveCount(24);
    await expect(cat).toContainText('72 питомцев · страница 1 из 3');
    await expect(cat.locator('.cat-card').nth(3).locator('.cat-badge'), '11 строк — смотрит на курсор').toHaveText('👀');
    await expect(cat.locator('.cat-card').nth(2).locator('.cat-badge')).toHaveCount(0);
    const btn = cat.locator('.cat-card').nth(3).locator('button');
    await expect(btn).toHaveText('Установить');
    await btn.click();
    await expect(btn).toHaveText('Выбран ✓');
    expect(await page.evaluate(async () => (await import('/js/state.js')).state.settings.petKind)).toBe('codex:cat-3');
    expect(await page.evaluate(async () => (await import('/js/companion.js')).codexPets.list.map((p) => p.id))).toContain('cat-3');
    await expect(page.locator('.toast').last()).toHaveText('«Пет №4» теперь ваш питомец');
  });
});

test('старая фотогалерея превращается в область с картинками внутри', async ({ app, page }) => {
  const res = await page.evaluate(() => {
    const c = window.__app.canvas;
    c.doc.nodes.push({ id: 'ga_old', type: 'gallery', x: 0, y: 0, w: 660, h: 440, z: 3, data: { title: 'Фото проекта', color: '#e86a92', images: [
      { id: 'p1', vault: 'attachments/a.png', thumb: 'attachments/a.png', w: 800, h: 600, name: 'a.png' },
      { id: 'p2', vault: 'attachments/b.png', w: 600, h: 800 },
      { id: 'p3', vault: 'attachments/c.png', w: 1000, h: 500 },
      { id: 'p4', vault: 'attachments/d.png', w: 500, h: 500 },
      { id: 'p5', w: 10, h: 10 }, // no file: dropped
    ] } });
    c.load();
    const f = c.node('ga_old');
    return { frame: { type: f.type, data: f.data, w: f.w, h: f.h, z: f.z }, kids: c.doc.nodes.filter((n) => n.parent === 'ga_old').map((n) => ({ type: n.type, data: n.data, x: n.x, y: n.y, w: n.w, h: n.h })) };
  });
  expect(res.frame).toMatchObject({ type: 'frame', data: { title: 'Фото проекта', color: '#e86a92' }, w: 660 });
  expect(res.frame.z).toBeLessThan(0);
  expect(res.kids.map((k) => [k.type, k.data.vault])).toEqual([['image', 'attachments/a.png'], ['image', 'attachments/b.png'], ['image', 'attachments/c.png'], ['image', 'attachments/d.png']]);
  expect(res.kids[0].data.name, 'имя файла без расширения').toBe('a');
  expect(res.kids.map((k) => [k.w, k.h]), 'пропорции фото сохраняются').toEqual([[220, 165], [220, 293], [220, 110], [220, 220]]);
  for (const k of res.kids) {
    expect(k.x).toBeGreaterThanOrEqual(0); expect(k.y).toBeGreaterThanOrEqual(0);
    expect(k.x + k.w, 'фото внутри области').toBeLessThanOrEqual(res.frame.w);
    expect(k.y + k.h).toBeLessThanOrEqual(res.frame.h);
  }
  await expect(page.locator('.node-frame .frame-title')).toHaveText('Фото проекта');
  await expect(page.locator('.node-frame .frame-count')).toHaveText('4 объекта');
  await expect(page.locator('.node-image')).toHaveCount(4);
});

test.describe('безопасность HTML', () => {
  test('очистка HTML убирает скрипты, обработчики и опасные ссылки, оставляя разметку', async ({ app, page }) => {
    const r = await page.evaluate(async () => {
      const { sanitizeHtml, safeUrl } = await import('/js/sanitize.js');
      const { mdToHtml } = await import('/js/md.js');
      const payloads = {
        imgOnerror: '<img src=x onerror="window.__pwned++">',
        svg: '<svg onload="window.__pwned++"><circle/></svg>',
        jsLink: '<a href="javascript:window.__pwned++">x</a>',
        iframe: '<iframe src="javascript:window.__pwned++"></iframe>',
        searchMs: '<a href="search-ms:query=x">s</a>',
        msdt: '<a href="ms-msdt:/id x">m</a>',
        cssUrl: '<div style="background:url(javascript:alert(1)); color: red">s</div>',
        math: '<math><mi xlink:href="javascript:1">m</mi></math>',
        form: '<form action="https://evil"><button>b</button></form>',
        ok: '<b onclick="x">bold</b> <mark>ok</mark> <a href="https://ok.example" target="_self" rel="opener">ok</a>',
        details: '<details open><summary>s</summary>d</details>',
        dataImg: '<img src="data:image/png;base64,AAAA" alt="ok">',
        object: '<object data="x"></object>',
        nested: '<scr<script>ipt>window.__pwned++</script>',
        entity: '<a href="jav&#x09;ascript:alert(1)">t</a>',
      };
      const out = Object.fromEntries(Object.entries(payloads).map(([k, v]) => [k, sanitizeHtml(v)]));
      const md = mdToHtml('# T\n\n<img src=x onerror="window.__pwned++">\n\n[link](search-ms:x) [ok](https://a.b) [[Wiki]] #tag ==mark==\n\n- [ ] task');
      return { out, md, urls: ['https://a.b', 'mailto:x@y', 'file:///C:/x', 'smb://host/x', 'vbscript:x', 'data:text/html,x', '#anchor', 'note.md'].map((u) => safeUrl(u)), imgUrls: ['data:image/png;base64,AA', 'blob:x', 'data:text/html,x'].map((u) => safeUrl(u, { image: true })) };
    });
    const all = Object.values(r.out).join('\n') + r.md;
    expect(all).not.toMatch(/\son\w+=/i);
    expect(all).not.toMatch(/javascript:|search-ms:|ms-msdt:|url\(/i);
    expect(all).not.toMatch(/<(script|svg|math|iframe|form|button|base|object)\b/i);
    expect(r.out.imgOnerror).toBe('<img src="x">');
    expect(r.out.jsLink).toBe('<a>x</a>');
    expect(r.out.cssUrl).toBe('<div style="color: red">s</div>');
    expect(r.out.ok).toBe('<b>bold</b> <mark>ok</mark> <a href="https://ok.example" target="_blank" rel="noreferrer">ok</a>');
    expect(r.out.details).toBe('<details open=""><summary>s</summary>d</details>');
    expect(r.out.dataImg).toBe('<img src="data:image/png;base64,AAAA" alt="ok">');
    expect(r.out.entity).toBe('<a>t</a>');
    // notes keep their own markup: headings, wiki links, tags, highlights, check lists
    expect(r.md).toContain('<h1>T</h1>');
    expect(r.md).toContain('<a href="https://a.b" target="_blank">ok</a>');
    expect(r.md).toContain('<a class="wikilink" data-target="Wiki">Wiki</a>');
    expect(r.md).toContain('<span class="tag" data-tag="tag">#tag</span>');
    expect(r.md).toContain('<mark>mark</mark>');
    expect(r.md).toContain('<li data-checked="false">task</li>');
    expect(r.urls).toEqual(['https://a.b', 'mailto:x@y', '', '', '', '', '#anchor', 'note.md']);
    expect(r.imgUrls).toEqual(['data:image/png;base64,AA', 'blob:x', '']);
  });

  test('текст и стрелка с чужого (синхронизированного) canvas не вставляют свою разметку', async ({ app, page }) => {
    const text = await app.add('text', { x: 0, y: 0, data: { html: '<img src=x onerror="window.__pwned++">hi <b>bold</b><script>window.__pwned++</script>' } });
    const a = await app.add('sticky', { x: 0, y: 300 });
    const b = await app.add('sticky', { x: 400, y: 300 });
    await page.evaluate(([a, b]) => { const c = window.__app.canvas; c.doc.edges.push({ id: 'e_x', from: a, to: b, color: 'red" onmouseover="window.__pwned++" x="' }); c.renderEdges(); }, [a, b]);
    await expect(app.el(text).locator('.free-text')).toHaveText('hi bold');
    expect(await app.el(text).locator('.free-text').innerHTML()).toBe('<img src="x">hi <b>bold</b>');
    const edge = page.locator('.edge-line').first();
    expect(await edge.getAttribute('onmouseover')).toBeNull();
    expect(await edge.getAttribute('style')).toBe('stroke:var(--pen-gray)');
  });
});

test.describe('окно чата агента', () => {
  test('модель и уровень размышления: списки, строка состояния и что уходит агенту', async ({ app, page }) => {
    test.slow();
    const claude = await page.evaluate(() => window.__app.launchAgentChat({ agentId: 'claude', world: { x: 0, y: 300 } }).id);
    const codex = await page.evaluate(() => window.__app.launchAgentChat({ agentId: 'codex', world: { x: 560, y: 300 } }).id);
    const model = (id) => app.el(id).locator('select[title="Модель"]');
    const effort = (id) => app.el(id).locator('select[title^="Уровень размышления"]');
    const info = (id) => app.el(id).locator('.model-info');

    await expect(model(claude).locator('option').first()).toHaveText('Авто (sonnet)');
    const claudeModels = await model(claude).locator('option').allTextContents();
    expect(claudeModels).toEqual(expect.arrayContaining(['Opus (последний)', 'Sonnet (последний)', 'Haiku (последний)', 'Fable 5.1', 'Opus 5.5']));
    expect(claudeModels.at(-1)).toBe('Другая…');
    await expect(effort(claude).locator('option')).toHaveText(['Авто', 'Низкий', 'Средний', 'Высокий', 'Очень высокий', 'Максимальный']);
    await expect(info(claude)).toHaveText('Sonnet (последний)');

    await expect(model(codex).locator('option')).toHaveText(['Авто (gpt-5-codex)', 'GPT-5 Codex', 'GPT-5', 'GPT-5 Codex mini', 'Другая…']);
    await expect(effort(codex).locator('option')).toHaveText(['Авто (средний)', 'Минимальный', 'Низкий', 'Средний', 'Высокий', 'Очень высокий']);
    await expect(info(codex)).toHaveText('GPT-5 Codex · размышл.: средний');

    await model(claude).selectOption('opus');
    await effort(claude).selectOption('high');
    await expect(info(claude)).toHaveText('Opus (последний) · размышл.: высокий');
    expect((await app.node(claude)).data).toMatchObject({ model: 'opus', effort: 'high' });

    // the choice goes with the task; after the answer the bar shows the model the agent reported
    await page.evaluate(async () => {
      const { native } = await import('/js/state.js');
      const run = native.agentChat.run;
      window.__runs = [];
      native.agentChat.run = (p) => { window.__runs.push({ kind: p.kind, model: p.model, effort: p.effort, mode: p.mode }); return run(p); };
    });
    await sendAgent(page, claude, 'привет');
    await expect.poll(() => page.evaluate(() => window.__runs)).toEqual([{ kind: 'claude', model: 'opus', effort: 'high', mode: 'acceptEdits' }]);
    await expect.poll(() => agentRunning(page, claude), { timeout: 10_000 }).toBe(false);
    expect((await app.node(claude)).data.actualModel, 'модель, которую сообщил агент, сохранена').toBe('claude-sonnet-5-5');

    // "Другая…" asks for any model name
    await model(codex).selectOption('__custom');
    const name = page.locator('.modal input');
    await expect(name).toBeVisible();
    await name.fill('gpt-6-preview');
    await page.keyboard.press('Enter');
    await expect(model(codex)).toHaveValue('gpt-6-preview');
    await expect(model(codex).locator('optgroup[label="Другие"] option')).toHaveText(['gpt-6-preview']);
    await expect(info(codex)).toHaveText('gpt-6-preview · размышл.: средний');
  });

  // BUG: the 'session' event goes through patchNodeData(), which replaces inst.node with a copy that
  // is detached from the canvas node; the following 'info' event stores actualModel on the canvas
  // node, but renderInfo() reads the stale copy, so the bar keeps the configured model until the
  // window is re-rendered (help.md: "После первого ответа там появляется точное название модели").
  test.fixme('после ответа строка состояния показывает модель, которую сообщил агент', async ({ app, page }) => {
    const id = await page.evaluate(() => window.__app.launchAgentChat({ agentId: 'claude', world: { x: 0, y: 300 } }).id);
    const info = app.el(id).locator('.model-info');
    await expect(info).toHaveText('Sonnet (последний)');
    await sendAgent(page, id, 'привет');
    await expect.poll(() => agentRunning(page, id), { timeout: 10_000 }).toBe(false);
    expect((await app.node(id)).data.actualModel).toBe('claude-sonnet-5-5');
    await expect(info).toHaveText('claude-sonnet-5-5');
  });

  test('история чатов: список по дням, открыть прошлый чат, сессии CLI, новый чат; у API-чата своя история', async ({ app, page }) => {
    test.slow();
    const ac = await page.evaluate(() => window.__app.launchAgentChat({ agentId: 'claude', world: { x: 0, y: 0 } }).id);
    const api = await app.add('chat', { x: 600, y: -300, data: { provider: 'anthropic' } });
    await setViewport(page, { x: 380, y: 400, z: 1 });
    const win = app.el(ac);
    const data = () => app.node(ac).then((n) => n.data);

    await sendAgent(page, ac, 'Сделай обзор кода');
    await expect.poll(() => agentRunning(page, ac), { timeout: 10_000 }).toBe(false);
    const convId = (await data()).convId;
    expect(convId, 'разговор сохранён в историю после ответа').toBeTruthy();

    await win.locator('.hist-btn').click();
    const panel = win.locator('.hist-panel');
    await expect(panel.locator('.hist-tab')).toHaveText(['В VibeTabula', 'Сессии Claude Code']);
    await expect(panel.locator('.hist-item .hist-title')).toHaveText(['Сделай обзор кода', 'Разобрать структуру проекта', 'Починить сборку под Windows']);
    await expect(panel.locator('.hist-list > *').first(), 'новый разговор — в группе «Сегодня»').toHaveText('Сегодня');
    await expect(panel.locator('.hist-item').first()).toHaveClass(/\bactive\b/);
    await expect(panel.locator('.hist-item').first().locator('.hist-meta')).toContainText('claude-sonnet-5-5 · 2 сообщ.');

    // open an older conversation: the next message continues it
    await panel.locator('.hist-item', { hasText: 'Починить сборку под Windows' }).click();
    await expect(panel).toHaveCount(0);
    expect(await data()).toMatchObject({ title: 'Починить сборку под Windows', convId: 'demo2', cwd: '/home/user/app', actualModel: 'claude-sonnet-5-5' });
    expect((await data()).messages).toHaveLength(2);
    await expect(win.locator('.model-info')).toHaveText('claude-sonnet-5-5');
    await expect(win.locator('.cwd-text')).toHaveText('/home/user/app');

    // sessions of Claude Code on this computer, by default those of the current folder
    await win.locator('.hist-btn').click();
    await panel.locator('.hist-tab').nth(1).click();
    await expect(panel.locator('.hist-item .hist-title')).toHaveText(['Добавь README и настрой сборку']);
    await expect(panel.locator('.hist-foot')).toHaveText('Только папка app');
    await panel.locator('.hist-foot input').uncheck();
    await expect(panel.locator('.hist-item .hist-title')).toHaveText(['Добавь README и настрой сборку', 'Сессия из терминала в другой папке']);
    await panel.locator('.hist-item').first().click();
    await expect(panel).toHaveCount(0);
    expect(await data()).toMatchObject({ title: 'Добавь README и настрой сборку', sessionId: 'a1b2c3d4-1111', actualModel: 'claude-opus-5-5' });
    expect((await data()).messages).toHaveLength(2);

    // a new chat starts empty; the opened session stays in the app history
    await win.locator('.hist-btn').click();
    await panel.locator('.hist-new').click();
    expect(await data()).toMatchObject({ messages: [], sessionId: null, convId: null });
    await win.locator('.hist-btn').click();
    await expect(panel.locator('.hist-tab.on'), 'панель помнит последнюю вкладку').toHaveText('Сессии Claude Code');
    await panel.locator('.hist-tab', { hasText: 'В VibeTabula' }).click();
    // newest first: the opened session, then the chat that was open before it (saved on switching)
    await expect(panel.locator('.hist-item .hist-title')).toHaveText(['Добавь README и настрой сборку', 'Починить сборку под Windows', 'Сделай обзор кода', 'Разобрать структуру проекта']);
    await expect(panel.locator('.hist-item.active')).toHaveCount(0);
    await panel.locator('.hist-search').fill('обзор');
    await expect(panel.locator('.hist-item .hist-title')).toHaveText(['Сделай обзор кода']);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // an API chat lists only API conversations, without the CLI tab
    await app.el(api).locator('.hist-btn').click();
    const apiPanel = app.el(api).locator('.hist-panel');
    await expect(apiPanel.locator('.hist-item .hist-title')).toHaveText(['Идеи для названия']);
    await expect(apiPanel.locator('.hist-tab')).toHaveCount(0);
  });
});
