const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};
const inv = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('native', {
  isElectron: true,
  win: { minimize: inv('win:minimize'), maximize: inv('win:maximize'), close: inv('win:close'), isMaximized: inv('win:isMaximized'), onState: on('win:state') },
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
  agentChat: { run: inv('agentchat:run'), abort: inv('agentchat:abort'), onEvent: on('agentchat:event') },
  setBg: inv('win:setBg'),
  limits: { get: inv('limits:get'), usage: inv('usage:get') },
  vault: {
    root: inv('vault:root'), setRoot: inv('vault:setRoot'), index: inv('vault:index'), read: inv('vault:read'), write: inv('vault:write'),
    create: inv('vault:create'), mkdir: inv('vault:mkdir'), rename: inv('vault:rename'), remove: inv('vault:remove'), search: inv('vault:search'),
    saveAsset: inv('vault:saveAsset'), readAsset: inv('vault:readAsset'), reveal: inv('vault:reveal'), onChanged: on('vault:changed'),
  },
  dialog: { folder: inv('dialog:folder') },
  shell: { open: inv('shell:open'), openPath: inv('shell:openPath') },
  clipboard: { write: inv('clipboard:write') },
});
