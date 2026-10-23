const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};
const inv = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('native', {
  isElectron: true,
  win: { minimize: inv('win:minimize'), maximize: inv('win:maximize'), close: inv('win:close'), isMaximized: inv('win:isMaximized'), focus: inv('win:focus'), attention: inv('win:attention'), onState: on('win:state') },
  info: inv('app:info'),
  ws: { load: inv('ws:load'), save: inv('ws:save') },
  canvas: { load: inv('canvas:load'), save: inv('canvas:save'), remove: inv('canvas:delete') },
  pty: {
    spawn: inv('pty:spawn'),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, c, r) => ipcRenderer.send('pty:resize', id, c, r),
    kill: inv('pty:kill'), attach: inv('pty:attach'), statuses: inv('pty:statuses'), which: inv('pty:which'),
    onData: on('pty:data'), onExit: on('pty:exit'),
  },
  chat: { providers: inv('chat:providers'), send: inv('chat:send'), abort: inv('chat:abort'), models: inv('chat:models'), onEvent: on('chat:event') },
  agentChat: { run: inv('agentchat:run'), abort: inv('agentchat:abort'), attach: inv('agentchat:attach'), release: inv('agentchat:release'), background: inv('agentchat:background'), onBackground: on('agentchat:background'), defaults: inv('agentchat:defaults'), imagesDir: inv('agentchat:imagesDir'), onEvent: on('agentchat:event') },
  setBg: inv('win:setBg'),
  perf: { info: inv('perf:info'), save: inv('perf:save') },
  history: { list: inv('history:list'), get: inv('history:get'), save: inv('history:save'), remove: inv('history:remove') },
  sessions: { list: inv('sessions:list'), read: inv('sessions:read') },
  app: { onFlush: on('app:flush'), flushed: () => ipcRenderer.send('app:flushed') },
  trust: { add: inv('trust:add') },
  attach: { saveBytes: inv('attach:saveBytes'), importPath: inv('attach:importPath'), open: inv('attach:open'), reveal: inv('attach:reveal'), pathForFile: (f) => { try { return webUtils.getPathForFile(f) || ''; } catch { return ''; } } },
  codexPets: { installed: inv('codexPets:installed'), catalog: inv('codexPets:catalog'), install: inv('codexPets:install'), remove: inv('codexPets:remove') },
  sync: { info: inv('sync:info'), configure: inv('sync:configure'), now: inv('sync:now'), ready: inv('sync:ready'), adoptVault: inv('sync:adoptVault'), onChanged: on('sync:changed'), onStatus: on('sync:status') },
  limits: { get: inv('limits:get'), usage: inv('usage:get') },
  vault: {
    root: inv('vault:root'), setRoot: inv('vault:setRoot'), index: inv('vault:index'), read: inv('vault:read'), write: inv('vault:write'),
    create: inv('vault:create'), createNumbered: inv('vault:createNumbered'), mkdir: inv('vault:mkdir'), rename: inv('vault:rename'), remove: inv('vault:remove'), search: inv('vault:search'),
    styles: inv('vault:styles'), setStyle: inv('vault:setStyle'), saveAsset: inv('vault:saveAsset'), readAsset: inv('vault:readAsset'), reveal: inv('vault:reveal'), onChanged: on('vault:changed'),
  },
  dialog: { folder: inv('dialog:folder') },
  shell: { open: inv('shell:open'), openPath: inv('shell:openPath') },
  wt: { isRepo: inv('wt:isRepo'), create: inv('wt:create'), status: inv('wt:status'), preview: inv('wt:preview'), merge: inv('wt:merge'), remove: inv('wt:remove') },
  changes: { snapshot: inv('changes:snapshot'), since: inv('changes:since'), patch: inv('changes:patch'), restore: inv('changes:restore'), reveal: inv('changes:reveal') },
  clipboard: { write: inv('clipboard:write') },
});
