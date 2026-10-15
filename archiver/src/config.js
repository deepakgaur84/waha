// All settings come from environment variables (set in the compose file).
const path = require('path');

const env = process.env;
const dataDir = env.DATA_DIR || '/data';

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  port: int(env.PORT, 3000),
  dataDir,
  dbPath: env.DB_PATH || path.join(dataDir, 'archive.db'),
  reportPath: env.REPORT_PATH || path.join(dataDir, 'import-report.json'),
  tmpDir: env.TMP_DIR || path.join(dataDir, 'tmp'),
  mediaDir: env.MEDIA_DIR || path.join(dataDir, 'media'),

  // ---- Stage 1: iOS backups ------------------------------------------------
  // Folder that contains the iOS backup snapshot folders (read-only mount).
  backupRoot: env.BACKUP_ROOT || '/backup',
  // Run the backup import automatically when the container starts.
  importOnStart: bool(env.BACKUP_IMPORT_ON_START, true),
  // latest = backups are cumulative, so only the newest snapshot is imported (default).
  // all    = import every snapshot, oldest first.
  importMode: (env.BACKUP_IMPORT_MODE || 'latest').toLowerCase() === 'all' ? 'all' : 'latest',
  // true = re-import snapshots that were already imported successfully.
  forceReimport: bool(env.FORCE_REIMPORT, false),
  // WAHA message-id codes to look for after the import (proof of id matching).
  probeStanzaIds: list(env.PROBE_STANZA_IDS).map((s) => s.toUpperCase()),

  // ---- Stage 2: WAHA ---------------------------------------------------------
  wahaBaseUrl: (env.WAHA_BASE_URL || 'http://waha:3000').replace(/\/+$/, ''),
  wahaSession: env.WAHA_SESSION || 'default',
  wahaApiKey: env.WAHA_API_KEY || '',
  // Same secret as WHATSAPP_HOOK_HMAC_KEY on the WAHA side. Empty = do not verify.
  hmacSecret: env.WAHA_WEBHOOK_HMAC_SECRET || '',

  // Pull history from WAHA's API when the container starts, then every N minutes.
  syncOnStart: bool(env.WAHA_SYNC_ON_START, true),
  syncIntervalMinutes: int(env.WAHA_SYNC_INTERVAL_MINUTES, 360),
  pageSize: int(env.WAHA_PAGE_SIZE, 100),
  // true = ignore the saved per-chat progress and read every chat's full history again.
  fullResync: bool(env.WAHA_FULL_RESYNC, false),
  // Incremental sync re-reads this far back from the newest message it has seen.
  overlapSeconds: int(env.WAHA_SYNC_OVERLAP_SECONDS, 6 * 3600),
  // Chats whose id ends with one of these are not archived.
  skipChatSuffixes: list(env.WAHA_SKIP_CHAT_SUFFIXES || '@newsletter,@broadcast'),
  requestTimeoutMs: int(env.WAHA_REQUEST_TIMEOUT_MS, 60000),

  // Media: only messages newer than the newest backup are downloaded from WAHA
  // (older ones come from the backup). Failed downloads are retried on later runs.
  mediaBatch: int(env.WAHA_MEDIA_BATCH, 500),
  mediaMaxAttempts: int(env.WAHA_MEDIA_MAX_ATTEMPTS, 5),
  mediaConcurrency: int(env.WAHA_MEDIA_CONCURRENCY, 2),
  mediaTimeoutMs: int(env.WAHA_MEDIA_TIMEOUT_MS, 180000),
  // With no backup in the archive, only fetch media newer than this many days.
  mediaDefaultDays: int(env.WAHA_MEDIA_DEFAULT_DAYS, 30),
};
