// Attachments in chat windows: paperclip button, drag & drop, paste from the clipboard,
// chips with previews above the input and a nice rendering inside messages.
import { h, icon, toast } from './util.js';
import { native } from './state.js';

const fmtSize = (n) => (n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${Math.round(n / 1024)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`);
// Apple system colours (light variants) for file badges
const EXT_COLORS = { pdf: '#ff3b30', doc: '#007aff', docx: '#007aff', xls: '#34c759', xlsx: '#34c759', csv: '#34c759', ppt: '#ff9500', pptx: '#ff9500', zip: '#af52de', rar: '#af52de', json: '#a2845e', md: '#8e8e93', txt: '#8e8e93' };
const extColor = (ext) => EXT_COLORS[ext] || (/^(js|ts|tsx|jsx|py|go|rs|java|c|cpp|cs|rb|php|sh|ps1|sql|html|css)$/.test(ext) ? '#5856d6' : '#8e8e93');
const ipcMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// small JPEG preview kept inside the message (so it shows even where the file itself isn't)
async function makeThumb(blob, max = 320) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const out = { thumb: c.toDataURL('image/jpeg', 0.78), w: bmp.width, h: bmp.height };
    bmp.close?.();
    return out;
  } catch { return {}; }
}

export function fileIcon(att, size = 38) {
  const ext = (att.ext || att.name?.split('.').pop() || '').toLowerCase().slice(0, 4);
  const el = h('div', { class: 'att-ficon', style: { width: `${size}px`, height: `${Math.round(size * 1.2)}px` } }, h('span', {}, ext.toUpperCase() || 'FILE'));
  el.style.setProperty('--fc', extColor(ext));
  return el;
}

export class AttachBar {
  constructor({ root, input, onChange }) {
    this.items = [];
    this.root = root; this.input = input; this.onChange = onChange;
    this.picker = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    this.picker.onchange = () => { this.addFiles([...this.picker.files]); this.picker.value = ''; };
    this.button = h('button', { class: 'chat-attach no-drag', title: 'Приложить файлы или картинки (или перетащите / вставьте Ctrl+V)', html: icon('paperclip', 17), onclick: (e) => { e.stopPropagation(); this.picker.click(); } });
    this.chips = h('div', { class: 'att-chips' });
    this.chips.style.display = 'none';
    root.append(this.picker);
    // drag & drop onto the chat window (and keep the canvas from grabbing the files)
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    root.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; root.classList.add('att-drop'); });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('att-drop'); });
    root.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); root.classList.remove('att-drop'); this.addFiles([...e.dataTransfer.files]); });
    // pasting an image / file
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation();
      this.addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Скриншот ${new Date().toLocaleTimeString('ru-RU').replace(/:/g, '-')}${i ? `-${i}` : ''}.png`, { type: f.type || 'image/png' }))));
    });
  }
  get busy() { return this.items.some((x) => x.pending); }
  async addFiles(files) {
    for (const f of files) {
      const item = { pending: true, name: f.name, size: f.size, kind: f.type.startsWith('image/') ? 'image' : 'file', ext: (f.name.split('.').pop() || '').toLowerCase() };
      if (item.kind === 'image') item.localUrl = URL.createObjectURL(f);
      this.items.push(item);
      this.render();
      try {
        const p = native.attach?.pathForFile?.(f);
        const meta = p ? await native.attach.importPath(p) : await native.attach.saveBytes({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        Object.assign(item, meta, { pending: false });
        if (item.kind === 'image') Object.assign(item, await makeThumb(f));
      } catch (e) {
        this.items = this.items.filter((x) => x !== item);
        toast(`Не удалось приложить «${f.name}»: ${ipcMsg(e)}`, 'error');
      }
      this.render();
    }
  }
  take() {
    const out = this.items.filter((x) => !x.pending).map(({ pending, localUrl, ...rest }) => rest);
    for (const x of this.items) if (x.localUrl) URL.revokeObjectURL(x.localUrl);
    this.items = [];
    this.render();
    return out;
  }
  render() {
    this.chips.replaceChildren(...this.items.map((x) => {
      const rm = h('button', { class: 'att-x', title: 'Убрать', html: icon('x', 11), onclick: (e) => { e.stopPropagation(); if (x.localUrl) URL.revokeObjectURL(x.localUrl); this.items = this.items.filter((y) => y !== x); this.render(); } });
      if (x.kind === 'image') {
        return h('div', { class: `att-chip img${x.pending ? ' pending' : ''}`, title: `${x.name} · ${fmtSize(x.size)}` }, h('img', { src: x.thumb || x.localUrl || x.url, alt: '' }), rm);
      }
      return h('div', { class: `att-chip file${x.pending ? ' pending' : ''}`, title: x.name }, fileIcon(x, 26), h('div', { class: 'att-meta' }, h('div', { class: 'att-name' }, x.name), h('div', { class: 'att-size' }, x.pending ? 'загрузка…' : fmtSize(x.size))), rm);
    }));
    this.chips.style.display = this.items.length ? '' : 'none';
    this.onChange?.();
  }
}

// attachments inside a sent message
export function renderAttachments(atts = []) {
  if (!atts.length) return null;
  const images = atts.filter((a) => a.kind === 'image');
  const files = atts.filter((a) => a.kind !== 'image');
  const box = h('div', { class: 'msg-atts' });
  if (images.length) {
    const grid = h('div', { class: `msg-imgs n${Math.min(images.length, 4)}` });
    images.forEach((a, i) => {
      const img = h('img', { src: a.url || a.thumb, alt: a.name, loading: 'lazy', title: a.name });
      img.onerror = () => { if (a.thumb && img.src !== a.thumb) img.src = a.thumb; };
      grid.append(h('button', { class: 'msg-img', onclick: (e) => { e.stopPropagation(); viewImages(images, i); } }, img));
    });
    box.append(grid);
  }
  for (const a of files) {
    box.append(h('button', { class: 'msg-file', title: 'Открыть файл', onclick: async (e) => { e.stopPropagation(); const r = await native.attach?.open?.(a.file); if (r) toast(String(r), 'warn'); } },
      fileIcon(a, 30), h('div', { class: 'att-meta' }, h('div', { class: 'att-name' }, a.name), h('div', { class: 'att-size' }, `${(a.ext || '').toUpperCase()} · ${fmtSize(a.size || 0)}`))));
  }
  return box;
}

// full-size viewer for the images of a message
export function viewImages(images, idx = 0) {
  const back = h('div', { class: 'lightbox' });
  const img = h('img', { class: 'lb-img' });
  const cap = h('div', { class: 'lb-cap' });
  const show = () => {
    const a = images[idx];
    img.onerror = () => { if (a.thumb && img.src !== a.thumb) img.src = a.thumb; };
    img.src = a.url || a.thumb;
    cap.textContent = `${images.length > 1 ? `${idx + 1} / ${images.length} · ` : ''}${a.name || ''}`;
  };
  const close = () => { back.remove(); document.removeEventListener('keydown', key, true); };
  const go = (d) => { idx = (idx + d + images.length) % images.length; show(); };
  const key = (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
  back.append(img, cap,
    images.length > 1 ? h('button', { class: 'lb-btn lb-prev', html: icon('chevronRight', 26), onclick: (e) => { e.stopPropagation(); go(-1); } }) : null,
    images.length > 1 ? h('button', { class: 'lb-btn lb-next', html: icon('chevronRight', 26), onclick: (e) => { e.stopPropagation(); go(1); } }) : null,
    h('div', { class: 'lb-tools' },
      h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); native.attach?.reveal?.(images[idx].file); } }, 'Показать в папке'),
      h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); close(); } }, 'Закрыть')));
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', key, true);
  document.body.append(back);
  show();
}
