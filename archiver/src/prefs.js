// Preferences: behaviour that can change without a redeploy. Saved to
// preferences.json in the data folder and read fresh on every use, so a change
// made in the reader applies at once (also in the backup-import process).
// docker-compose keeps only infrastructure and secrets; the env values below
// are just the first defaults, used until a preference has been saved.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = process.env.PREFERENCES_PATH || path.join(cfg.dataDir, 'preferences.json');

const OPTIONS = {
  reader_mode: ['ios', 'android', 'all'],
  chat_sort: ['latest', 'oldest', 'name_asc', 'name_desc'],
  date_format: ['dmy_12h', 'ymd_24h', 'mdy_12h'],
  backup_import_mode: ['latest', 'all'],
};

const DEFAULTS = {
  // Which backup source the reader shows. Messages that only WAHA has are shown in every mode.
  reader_mode: 'ios',
  date_format: 'dmy_12h',
  // Order of the chat list: latest = newest message on top, oldest = oldest last-message on top, name_asc = A-Z, name_desc = Z-A.
  chat_sort: 'latest',
  // latest = backups are cumulative, only the newest iOS snapshot is considered.
  backup_import_mode: cfg.importMode,
  // Backup folders (by name) that the importer must never read.
  excluded_backup_folders: [],
  // Minutes between WAHA syncs. 0 = only at start.
  sync_interval_minutes: cfg.syncIntervalMinutes,
  // Chats whose id ends with one of these are not archived.
  skip_chat_suffixes: cfg.skipChatSuffixes,
  // Fetch profile photos from WAHA (slowly, in the background after a sync).
  fetch_avatars: true,
};

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function clean(input) {
  const out = {};
  const src = input || {};
  for (const key of Object.keys(OPTIONS)) {
    if (src[key] !== undefined && OPTIONS[key].includes(src[key])) out[key] = src[key];
  }
  if (Array.isArray(src.excluded_backup_folders)) {
    out.excluded_backup_folders = src.excluded_backup_folders
      .map((s) => String(s).trim())
      .filter((s) => s && !s.includes('/') && !s.includes('\\') && s !== '..');
  }
  if (src.sync_interval_minutes !== undefined) {
    const n = Number(src.sync_interval_minutes);
    if (Number.isFinite(n) && n >= 0 && n <= 10080) out.sync_interval_minutes = Math.round(n);
  }
  if (typeof src.fetch_avatars === 'boolean') out.fetch_avatars = src.fetch_avatars;
  if (Array.isArray(src.skip_chat_suffixes)) {
    out.skip_chat_suffixes = src.skip_chat_suffixes.map((s) => String(s).trim()).filter(Boolean);
  }
  return out;
}

function get() {
  return { ...DEFAULTS, ...clean(readFile()) };
}

// Returns the saved preferences, or throws with a readable message for bad input.
function save(update) {
  const bad = Object.keys(update || {}).filter((k) => !(k in DEFAULTS));
  if (bad.length) throw new Error(`Unknown preference: ${bad.join(', ')}`);
  for (const key of Object.keys(OPTIONS)) {
    if (update[key] !== undefined && !OPTIONS[key].includes(update[key])) {
      throw new Error(`Invalid value for ${key}: ${update[key]}`);
    }
  }
  if (update.fetch_avatars !== undefined && typeof update.fetch_avatars !== 'boolean') {
    throw new Error('fetch_avatars must be true or false');
  }
  if (update.sync_interval_minutes !== undefined) {
    const n = Number(update.sync_interval_minutes);
    if (!Number.isFinite(n) || n < 0 || n > 10080) throw new Error('sync_interval_minutes must be between 0 and 10080');
  }
  const next = { ...get(), ...clean(update) };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  return next;
}

module.exports = { get, save, DEFAULTS, OPTIONS, FILE };
