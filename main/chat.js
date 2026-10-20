// API chat with streaming. OpenAI-compatible providers + Anthropic Messages API.

const PROVIDERS = {
  openai:     { name: 'OpenAI',      kind: 'openai',    baseUrl: 'https://api.openai.com/v1',                      model: 'gpt-5' },
  anthropic:  { name: 'Anthropic',   kind: 'anthropic', baseUrl: 'https://api.anthropic.com',                      model: 'claude-sonnet-5-5' },
  moonshot:   { name: 'Kimi (Moonshot)', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1',                    model: 'kimi-k2-turbo-preview' },
  openrouter: { name: 'OpenRouter',  kind: 'openai',    baseUrl: 'https://openrouter.ai/api/v1',                   model: 'openrouter/auto' },
  deepseek:   { name: 'DeepSeek',    kind: 'openai',    baseUrl: 'https://api.deepseek.com/v1',                    model: 'deepseek-chat' },
  gemini:     { name: 'Gemini',      kind: 'openai',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  ollama:     { name: 'Ollama (локально)', kind: 'openai', baseUrl: 'http://localhost:11434/v1',                   model: 'llama3.1', noKey: true },
  custom:     { name: 'Свой (OpenAI-совместимый)', kind: 'openai', baseUrl: 'http://localhost:1234/v1',            model: 'local-model', noKey: true },
};

function cfgFor(providerId, settings) {
  const def = PROVIDERS[providerId] || PROVIDERS.custom;
  const user = (settings && settings.providers && settings.providers[providerId]) || {};
  return {
    id: providerId,
    kind: def.kind,
    name: def.name,
    baseUrl: (user.baseUrl || def.baseUrl).replace(/\/+$/, ''),
    key: user.key || '',
    model: user.model || def.model,
    noKey: !!def.noKey,
  };
}

function pickRateHeaders(headers, kind) {
  const h = (k) => headers.get(k);
  if (kind === 'anthropic') {
    const lim = Number(h('anthropic-ratelimit-tokens-limit'));
    const rem = Number(h('anthropic-ratelimit-tokens-remaining'));
    const reset = h('anthropic-ratelimit-tokens-reset');
    if (lim > 0 && !Number.isNaN(rem)) return { used: Math.round((1 - rem / lim) * 100), limit: lim, remaining: rem, resetsAt: reset ? Date.parse(reset) : null };
    return null;
  }
  const lim = Number(h('x-ratelimit-limit-tokens'));
  const rem = Number(h('x-ratelimit-remaining-tokens'));
  if (lim > 0 && !Number.isNaN(rem)) {
    const reset = h('x-ratelimit-reset-tokens');
    let resetsAt = null;
    if (reset) {
      const m = /(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:(\d+)ms)?/.exec(reset);
      if (m) resetsAt = Date.now() + ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0);
    }
    return { used: Math.round((1 - rem / lim) * 100), limit: lim, remaining: rem, resetsAt };
  }
  return null;
}

async function* sseLines(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      yield line;
    }
  }
  if (buf) yield buf;
}

class ChatManager {
  constructor({ send, onUsage }) {
    this.send = send;
    this.onUsage = onUsage;
    this.inflight = new Map();
    this.rateLimits = {};
  }

  abort(reqId) {
    const c = this.inflight.get(reqId);
    if (c) { c.abort(); this.inflight.delete(reqId); }
  }

  async listModels(providerId, settings) {
    const cfg = cfgFor(providerId, settings);
    const headers = {};
    if (cfg.kind === 'anthropic') { headers['x-api-key'] = cfg.key; headers['anthropic-version'] = '2023-06-01'; }
    else if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
    const url = cfg.kind === 'anthropic' ? `${cfg.baseUrl}/v1/models?limit=100` : `${cfg.baseUrl}/models`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    const j = await res.json();
    const arr = j.data || j.models || [];
    return arr.map((m) => m.id || m.name).filter(Boolean).sort();
  }

  async send_({ reqId, provider, model, system, messages, temperature, settings }) {
    const cfg = cfgFor(provider, settings);
    const useModel = model || cfg.model;
    const ctrl = new AbortController();
    this.inflight.set(reqId, ctrl);
    const emit = (type, payload) => this.send('chat:event', { reqId, type, ...payload });
    let usage = { input: 0, output: 0 };
    try {
      if (!cfg.key && !cfg.noKey) throw new Error(`Нет API-ключа для «${cfg.name}». Добавьте его в Настройки → Провайдеры.`);
      let res;
      if (cfg.kind === 'anthropic') {
        res = await fetch(`${cfg.baseUrl}/v1/messages`, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: useModel, max_tokens: 8192, stream: true,
            ...(system ? { system } : {}),
            ...(temperature != null ? { temperature } : {}),
            messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
          }),
        });
      } else {
        const body = {
          model: useModel, stream: true,
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m) => ({ role: m.role, content: m.content }))],
          ...(temperature != null ? { temperature } : {}),
        };
        if (['openai', 'openrouter', 'deepseek'].includes(provider)) body.stream_options = { include_usage: true };
        const headers = { 'content-type': 'application/json' };
        if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
        if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://canvastty.local'; headers['X-Title'] = 'CanvasTTY'; }
        res = await fetch(`${cfg.baseUrl}/chat/completions`, { method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(body) });
      }

      const rl = pickRateHeaders(res.headers, cfg.kind);
      if (rl) { this.rateLimits[provider] = { ...rl, at: Date.now() }; }

      if (!res.ok) {
        let text = await res.text().catch(() => '');
        try { const j = JSON.parse(text); text = (j.error && (j.error.message || j.error)) || j.message || text; } catch {}
        throw new Error(`${res.status}: ${typeof text === 'string' ? text : JSON.stringify(text)}`.slice(0, 600));
      }

      for await (const line of sseLines(res.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (cfg.kind === 'anthropic') {
          if (j.type === 'content_block_delta' && j.delta) {
            if (j.delta.type === 'text_delta') emit('delta', { text: j.delta.text });
            else if (j.delta.type === 'thinking_delta') emit('reasoning', { text: j.delta.thinking });
          } else if (j.type === 'message_start' && j.message && j.message.usage) {
            usage.input = j.message.usage.input_tokens || 0;
          } else if (j.type === 'message_delta' && j.usage) {
            usage.output = j.usage.output_tokens || 0;
          } else if (j.type === 'error') {
            throw new Error(j.error && j.error.message || 'Ошибка потока');
          }
        } else {
          const ch = j.choices && j.choices[0];
          if (ch && ch.delta) {
            if (ch.delta.content) emit('delta', { text: ch.delta.content });
            const r = ch.delta.reasoning_content || ch.delta.reasoning;
            if (r) emit('reasoning', { text: r });
          }
          if (j.usage) { usage.input = j.usage.prompt_tokens || 0; usage.output = j.usage.completion_tokens || 0; }
        }
      }
      if (this.onUsage) this.onUsage(provider, usage);
      emit('done', { usage, model: useModel });
    } catch (e) {
      if (e.name === 'AbortError') emit('done', { usage, aborted: true });
      else emit('error', { message: e.message || String(e) });
    } finally {
      this.inflight.delete(reqId);
    }
  }
}

module.exports = { ChatManager, PROVIDERS, cfgFor };
