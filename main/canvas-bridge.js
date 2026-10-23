// A local channel between the agents' MCP server (main/mcp-history.js, started by Codex / Claude
// Code) and the running app, for the canvas tools: an agent sees and adds to the canvas of its own
// chat window. Windows: a named pipe, elsewhere a socket file; one JSON line per request:
//   → { id, token, op, args }      ← { id, result } | { id, error }
// The token names the chat run (main/agentchat.js gives each run its own); it decides which canvas
// and which window the request is about, so an agent can never reach another canvas.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_LINE = 4 * 1024 * 1024; // a request (a note's markdown at most) is far smaller

function pipePath(userData) {
  const id = crypto.createHash('sha1').update(String(userData || '')).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\vibetabula-canvas-${id}` : path.join(os.tmpdir(), `vibetabula-canvas-${id}.sock`);
}

class CanvasBridge {
  // resolve(token) → { nodeId, docId } | null; request(target, op, args) → Promise<result>
  constructor({ userData, resolve, request }) {
    this.path = pipePath(userData);
    this.resolve = resolve;
    this.request = request;
    this.server = null;
  }
  start(onReady) {
    if (process.platform !== 'win32') { try { fs.unlinkSync(this.path); } catch {} } // left by a crash
    this.server = net.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('data', (d) => {
        buf += d;
        if (buf.length > MAX_LINE) { conn.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.trim()) this.handle(line).then((out) => { try { conn.write(JSON.stringify(out) + '\n'); } catch {} });
        }
      });
      conn.on('error', () => {});
    });
    this.server.on('error', (e) => console.error('canvas bridge', e.message));
    this.server.listen(this.path, () => {
      if (process.platform !== 'win32') { try { fs.chmodSync(this.path, 0o600); } catch {} }
      if (onReady) onReady(this.path);
    });
    return this;
  }
  async handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return { error: 'bad request' }; }
    const { id, token, op, args } = msg || {};
    const target = typeof token === 'string' ? this.resolve(token) : null;
    if (!target) return { id, error: 'Этот запуск агента уже закончился или VibeTabula перезапущен — инструменты холста недоступны.' };
    try { return { id, result: await this.request(target, String(op || ''), args && typeof args === 'object' ? args : {}) }; }
    catch (e) { return { id, error: String(e.message || e) }; }
  }
  stop() { try { this.server?.close(); } catch {} if (process.platform !== 'win32') { try { fs.unlinkSync(this.path); } catch {} } }
}

// the client side, used by the MCP server: one request per connection
function call(pipe, token, op, args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipe);
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('VibeTabula не ответил вовремя')); }, timeout);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, token, op, args }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(t); sock.end();
      let r; try { r = JSON.parse(buf.slice(0, i)); } catch { reject(new Error('плохой ответ VibeTabula')); return; }
      if (r.error) reject(new Error(r.error)); else resolve(r.result);
    });
    sock.on('error', (e) => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'VibeTabula закрыт — инструменты холста работают, пока приложение открыто' : e.message)); });
  });
}

module.exports = { CanvasBridge, pipePath, call };
