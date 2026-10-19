// The archiver service.
//  1. Imports the iOS backups (in a child process, so this server stays responsive).
//  2. Pulls history from WAHA's API, then again on the interval set in Preferences.
//  3. Receives WAHA webhooks for live messages (internal network only).
//  4. Serves the reader: web page at "/", its API at "/reader/api".
const express = require('express');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { db } = require('./db');
const prefsStore = require('./prefs');
const { router: webhookRouter } = require('./webhook');
const { runSync, syncState } = require('./wahaSync');
const { runBackupImport, importState } = require('./importRunner');
const reader = require('./reader');
const { replayStored } = require('./events');
const { syncAvatars, setAfterRun } = require('./avatars');

// Shown at start-up so the log tells you which version is really running.
const BUILD = 'stage5.2 (Auto reader mode, first-run README)';

const app = express();

// Profile photos are fetched slowly in the background after a sync; the chat list refreshes when done.
function refreshAvatars() {
  syncAvatars().then(() => reader.invalidateChats()).catch((e) => console.error(`[avatars] ${e.message}`));
}

// The webhook is only for WAHA, over the Docker network. Requests that carry reverse-proxy
// forwarding headers are refused. The signature check (WAHA_WEBHOOK_HMAC_SECRET) is the real
// protection, so that secret must always be set.
app.use('/webhook', (req, res, next) => {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-host']) {
    return res.status(404).end();
  }
  return next();
});
// The webhook route parses its own raw body, so it is mounted before anything else.
app.use(webhookRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (_req, res) => {
  const count = (sql) => db.prepare(sql).get().n;
  res.json({
    messages: count('SELECT COUNT(*) AS n FROM messages'),
    chats: count('SELECT COUNT(*) AS n FROM chats'),
    messages_by_source: db.prepare('SELECT source, COUNT(*) AS n FROM messages GROUP BY source').all(),
    messages_seen_by_waha: count('SELECT COUNT(*) AS n FROM messages WHERE in_waha = 1'),
    waha_media: db
      .prepare("SELECT COALESCE(waha_media_state, 'none') AS state, COUNT(*) AS n FROM messages WHERE waha_media_state IS NOT NULL GROUP BY waha_media_state")
      .all(),
    lid_mappings: count('SELECT COUNT(*) AS n FROM lid_map'),
    unhandled_webhook_events: count('SELECT COUNT(*) AS n FROM webhook_unhandled'),
    import: importState(),
    sync: syncState,
    snapshots: db.prepare('SELECT snapshot, status, started_at, finished_at FROM import_runs ORDER BY snapshot').all(),
  });
});

app.get('/api/report', (_req, res) => {
  if (!fs.existsSync(cfg.reportPath)) return res.status(404).json({ error: 'No import report yet' });
  return res.type('application/json').send(fs.readFileSync(cfg.reportPath));
});

// The reader: API first, then the static page.
app.use('/reader/api', reader.router);
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------- schedule
// The interval comes from Preferences and is re-read after every run and every save.
let timer = null;
let scheduleEnabled = false;
function schedule() {
  clearTimeout(timer);
  if (!scheduleEnabled || !cfg.wahaEnabled) return;
  const minutes = prefsStore.get().sync_interval_minutes;
  if (!(minutes > 0)) return;
  timer = setTimeout(async () => {
    try { await runSync(); } catch (e) { console.error(`[sync] ${e.message}`); }
    reader.invalidateChats();
    refreshAvatars();
    schedule();
  }, minutes * 60 * 1000);
}
reader.setPrefsHook(schedule);
setAfterRun(() => reader.invalidateChats());

async function start() {
  // Reactions, edits and deletions that an earlier version only stored raw are applied now.
  const replayed = replayStored();
  if (replayed.applied || replayed.unusable) {
    console.log(`[archiver] stored webhook events applied: ${replayed.applied}, unusable: ${replayed.unusable}`);
  }
  if (cfg.importOnStart) {
    console.log('[archiver] BACKUP_IMPORT_ON_START=true, starting backup import');
    await runBackupImport();
    reader.invalidateChats();
  }
  if (!cfg.wahaEnabled) {
    console.log('[archiver] WAHA_ENABLED=false: backup-only mode, no WAHA sync or profile photos');
  } else if (cfg.syncOnStart) {
    console.log('[archiver] WAHA_SYNC_ON_START=true, starting WAHA sync');
    let ok = await runSync();
    // WAHA may still be starting (or the session not WORKING yet): retry every 2 minutes
    // instead of waiting for the next scheduled sync.
    for (let attempt = 1; !ok && attempt <= 30; attempt += 1) {
      console.log(`[archiver] sync did not complete (${syncState.last_error}); retry ${attempt}/30 in 2 minutes`);
      await new Promise((r) => setTimeout(r, 2 * 60 * 1000));
      ok = await runSync();
    }
    reader.invalidateChats();
    if (ok) refreshAvatars();
  }
  scheduleEnabled = true;
  schedule();
}

app.listen(cfg.port, () => {
  console.log(`[archiver] build ${BUILD} listening on ${cfg.port}, database ${cfg.dbPath}`);
  if (cfg.wahaEnabled && !cfg.hmacSecret) {
    console.warn('[archiver] WARNING: WAHA_WEBHOOK_HMAC_SECRET is empty, so webhook requests are NOT verified. Set it (and WHATSAPP_HOOK_HMAC_KEY on WAHA).');
  }
  start().catch((e) => console.error(`[archiver] startup failed: ${e.stack || e.message}`));
});
