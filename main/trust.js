// Commands the terminals and agent chats may start. Agent commands live in workspace settings and
// canvas JSON, which also arrive from the sync folder (another computer, or anyone who can write
// to that cloud folder). So a command line that was never run on THIS computer is shown to the
// user in a native dialog first; the list of approved commands is stored locally and never synced.
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');

// the stock agents as shipped (cmd + args / resume args)
const BUILTIN = new Set(['', 'claude', 'claude --continue', 'codex', 'codex resume --last', 'kimi', 'kimi --continue', 'gemini', 'agentchat:claude', 'agentchat:codex']);

class Trust {
  constructor({ userData, getWin }) {
    this.file = path.join(userData, 'trusted-commands.json');
    this.getWin = getWin;
    this.pending = new Map();
    try { this.set = new Set(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { this.set = new Set(); }
  }
  static line(cmd, args) { return [cmd, ...(args || [])].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); }
  has(key) { return BUILTIN.has(key) || this.set.has(key); }
  // the user typed / changed it in Settings on this computer
  add(keys) {
    let changed = false;
    for (const k of [].concat(keys || [])) { const v = String(k || '').replace(/\s+/g, ' ').trim(); if (v && !this.set.has(v)) { this.set.add(v); changed = true; } }
    if (changed) this.save();
  }
  save() {
    try { const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify([...this.set].slice(-500), null, 1)); fs.renameSync(tmp, this.file); } catch {}
  }
  async ensure(key, { what = 'Терминал хочет выполнить команду', cwd = '' } = {}) {
    if (this.has(key)) return true;
    if (this.pending.has(key)) return this.pending.get(key);
    const win = this.getWin();
    const p = dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', title: 'CanvasTTY', noLink: true,
      buttons: ['Разрешить', 'Отмена'], defaultId: 1, cancelId: 1,
      message: `${what}:`,
      detail: `${key.replace(/^agentchat:/, '')}\n${cwd ? `\nПапка: ${cwd}\n` : ''}\nЭта команда ещё не запускалась на этом компьютере. Она могла прийти с другого компьютера через синхронизацию. Если вы её не задавали — нажмите «Отмена».`,
    }).then((r) => { const ok = r.response === 0; if (ok) this.add(key); return ok; }).catch(() => false).finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }
}

module.exports = { Trust };
