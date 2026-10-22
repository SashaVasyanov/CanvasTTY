// Runs one turn of an agent CLI (Codex / Claude Code) detached from the app, so the answer is not
// lost when VibeTabula is closed or reloaded mid-answer. Started by agentchat.js with
// ELECTRON_RUN_AS_NODE=1:   <app executable> agent-runner.js <journal folder>
//
// The journal folder:
//   run.json    { file, args, verbatim, cwd }   the command to start
//   prompt.txt  the CLI's stdin (the message)
//   out.jsonl   the CLI's stdout (JSON events), err.log its stderr
//   alive       touched every 2 s while the turn runs (the app checks that the helper still works)
//   exit.json   { code, signal, at }, written once the CLI has exited
// Plain Node, no dependencies, no Electron APIs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = process.argv[2];
const file = (name) => path.join(dir, name);
let done = false;

function finish(code, signal) {
  if (done) return;
  done = true;
  clearInterval(beat);
  try { fs.writeFileSync(file('exit.json'), JSON.stringify({ code, signal: signal || null, at: Date.now() })); } catch {}
  process.exit(0);
}
function touch() {
  const t = new Date();
  try { fs.utimesSync(file('alive'), t, t); } catch { try { fs.writeFileSync(file('alive'), ''); } catch {} }
}

touch();
const beat = setInterval(touch, 2000);

let child = null;
try {
  const spec = JSON.parse(fs.readFileSync(file('run.json'), 'utf8'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the agent's own tools must not inherit it
  const stdio = [fs.openSync(file('prompt.txt'), 'r'), fs.openSync(file('out.jsonl'), 'w'), fs.openSync(file('err.log'), 'w')];
  child = spawn(spec.file, spec.args || [], { cwd: spec.cwd || undefined, env, stdio, windowsHide: true, windowsVerbatimArguments: !!spec.verbatim });
  for (const f of stdio) { try { fs.closeSync(f); } catch {} } // the CLI has its own copies
  child.on('error', (e) => { try { fs.appendFileSync(file('err.log'), `${e.message}\n`); } catch {} finish(-1, null); });
  child.on('exit', (code, signal) => finish(code, signal));
} catch (e) {
  try { fs.appendFileSync(file('err.log'), `${e.message}\n`); } catch {}
  finish(-1, null);
}

// "Stop" in the app ends the whole process group (Linux/macOS) or tree (Windows); if only this
// helper gets the signal, pass it on and record the exit
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(s, () => {
    try { child?.kill('SIGTERM'); } catch {}
    setTimeout(() => finish(null, s), 3000).unref();
  });
}
