// Runs the backup import in a separate process (so the server stays responsive)
// and remembers its state. Shared by the start-up routine and the reader's
// "Run backup import" button.
const { fork } = require('child_process');
const path = require('path');

let state = { running: false, last_exit_code: null, started_at: null, finished_at: null };

function importState() {
  return state;
}

// Resolves when the import has finished. A second call while one is running joins nothing and returns at once.
function runBackupImport() {
  return new Promise((resolve) => {
    if (state.running) return resolve(false);
    state = { running: true, last_exit_code: null, started_at: new Date().toISOString(), finished_at: null };
    const child = fork(path.join(__dirname, 'backupImport.js'), [], { stdio: 'inherit' });
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      state = { ...state, running: false, last_exit_code: code, finished_at: new Date().toISOString() };
      console.log(`[archiver] backup import finished (code ${code})`);
      // A child that lingers after reporting "done" is stopped so it cannot hold the database.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } }, 30000).unref();
      resolve(true);
    };
    // "done" arrives as soon as the import is complete, even if the process is slow to exit.
    child.on('message', (m) => { if (m && m.done) finish(m.code); });
    child.on('exit', (code) => finish(code));
    child.on('error', (e) => { console.error(`[archiver] import process error: ${e.message}`); finish(-1); });
  });
}

module.exports = { runBackupImport, importState };
