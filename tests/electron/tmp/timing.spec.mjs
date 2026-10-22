import { test, expect } from '../fixtures.mjs';
test('timing', async ({ launchApp }) => {
  for (let i = 0; i < 3; i++) {
    const app = await launchApp();
    let t = Date.now();
    const proc = app.proc;
    const exited = new Promise((r) => proc.once('exit', r));
    await app.main(({ app, ipcMain, BrowserWindow }) => {
      const t0 = Date.now(); const log = (m) => console.log(`T+${Date.now() - t0} ${m}`);
      const w = BrowserWindow.getAllWindows()[0];
      w.on('close', () => log('close')); w.on('closed', () => log('closed'));
      ipcMain.on('app:flushed', () => log('flushed'));
      app.on('window-all-closed', () => log('all-closed')); app.on('will-quit', () => log('will-quit')); app.on('quit', () => log('quit'));
      process.on('exit', () => log('exit'));
    });
    await app.page.locator('.win-btn.close').click({ noWaitAfter: true });
    console.log('click', Date.now() - t);
    await exited;
    console.log('exit', Date.now() - t);
    console.log(app.mainLog.split('\n').filter(l => l.startsWith('T+') || /debugger/i.test(l)).join(' | '));
    app.electronApp = null;
  }
});
