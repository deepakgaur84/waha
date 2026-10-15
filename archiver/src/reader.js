// The reader's API (mounted at /reader/api). It only reads the archive database
// and the media files; access control is done in front of it (Authelia + proxy).
//
// "Reader mode" (preference) decides which backup source is shown:
//   ios      -> messages from iOS backups, plus messages that only WAHA has
//   android  -> messages from Android backups, plus messages that only WAHA has
//   all      -> everything
// WAHA-only messages (backup_kind IS NULL) are live data, so they show in every mode.
const express = require('express');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { db } = require('./db');
const prefsStore = require('./prefs');
const { discoverSnapshots } = require('./backupImport');
const { importState, runBackupImport } = require('./importRunner');
const { runSync, syncState } = require('./wahaSync');
const { processPendingMedia } = require('./mediaStore');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker', 'gif']);

// ---------------------------------------------------------------- helpers

function modeFilter() {
  const mode = prefsStore.get().reader_mode;
  if (mode === 'all') return { sql: '1 = 1', params: [] };
  return { sql: '(m.backup_kind IS NULL OR m.backup_kind = ?)', params: [mode] };
}

function numberFromJid(jid) {
  const local = String(jid || '').split('@')[0];
  const digits = local.replace(/\D/g, '');
  return digits ? `+${digits}` : local;
}

let chatCache = { key: '', at: 0, value: null };
function invalidateChats() {
  chatCache = { key: '', at: 0, value: null };
}

function chatList() {
  const mode = prefsStore.get().reader_mode;
  if (chatCache.value && chatCache.key === mode && Date.now() - chatCache.at < 20000) return chatCache.value;
  const f = modeFilter();
  const rows = db
    .prepare(`SELECT m.chat_id AS chat_id, COUNT(*) AS n, MAX(m.ts) AS last_ts FROM messages m WHERE ${f.sql} GROUP BY m.chat_id ORDER BY last_ts DESC`)
    .all(...f.params);
  const meta = new Map(db.prepare('SELECT chat_id, kind, name FROM chats').all().map((c) => [c.chat_id, c]));
  const value = rows.map((r) => {
    const c = meta.get(r.chat_id) || {};
    const isGroup = c.kind === 'group' || r.chat_id.endsWith('@g.us');
    return {
      id: r.chat_id,
      name: c.name || (isGroup ? 'Group' : numberFromJid(r.chat_id)),
      is_group: isGroup,
      label: isGroup ? 'Group' : numberFromJid(r.chat_id),
      last_date: r.last_ts,
      count: r.n,
    };
  });
  chatCache = { key: mode, at: Date.now(), value };
  return value;
}

// Messages are paged with a cursor "<ts>~<msg_key>" so several messages in the same second are never lost.
function messagesPage(chatId, cursor, limit) {
  const f = modeFilter();
  let sql = `SELECT m.msg_key, m.ts, m.from_me, m.sender_jid, m.sender_name, m.type, m.text, m.media_title,
                    m.media_on_disk, m.waha_media_state, m.waha_media_path
             FROM messages m WHERE m.chat_id = ? AND ${f.sql}`;
  const params = [chatId, ...f.params];
  if (cursor) {
    const i = cursor.indexOf('~');
    const ts = Number(cursor.slice(0, i));
    const key = cursor.slice(i + 1);
    if (i > 0 && Number.isFinite(ts)) {
      sql += ' AND (m.ts < ? OR (m.ts = ? AND m.msg_key < ?))';
      params.push(ts, ts, key);
    }
  }
  sql += ' ORDER BY m.ts DESC, m.msg_key DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).reverse().map((r) => {
    const isMedia = MEDIA_TYPES.has(r.type);
    const available = (r.waha_media_state === 'done' && r.waha_media_path) || r.media_on_disk === 1;
    return {
      cur: `${r.ts}~${r.msg_key}`,
      id: r.msg_key,
      date: r.ts,
      is_from_me: r.from_me === 1,
      from_jid: r.sender_jid,
      from_name: r.sender_name,
      type: r.type,
      text: r.text,
      is_media: isMedia,
      has_media: Boolean(isMedia && available),
      media_state: !isMedia ? null : available ? 'ok' : r.waha_media_state === 'pending' ? 'pending' : 'missing',
      media_title: r.media_title,
    };
  });
}

// ------------------------------------------------------------------ media

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
  ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf',
};

function sniffMime(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    fs.closeSync(fd);
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
    if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
    if (b.slice(4, 8).toString() === 'ftyp') return 'video/mp4';
    if (b.slice(0, 4).toString() === 'OggS') return 'audio/ogg';
    if (b.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  } catch (_) { /* fall through */ }
  return 'application/octet-stream';
}

function inside(root, abs) {
  const r = path.resolve(root) + path.sep;
  return path.resolve(abs).startsWith(r);
}

function mediaFor(row) {
  if (row.waha_media_state === 'done' && row.waha_media_path) {
    const abs = path.join(cfg.mediaDir, row.waha_media_path);
    if (inside(cfg.mediaDir, abs) && fs.existsSync(abs)) {
      const ext = path.extname(abs).replace('.', '').toLowerCase();
      return { abs, mime: row.waha_media_mime || EXT_MIME[ext] || sniffMime(abs) };
    }
  }
  if (row.media_on_disk === 1 && row.media_snapshot && row.media_file_id) {
    const abs = path.join(cfg.backupRoot, row.media_snapshot, row.media_file_id.slice(0, 2), row.media_file_id);
    if (inside(cfg.backupRoot, abs) && fs.existsSync(abs)) {
      const ext = path.extname(row.media_rel_path || '').replace('.', '').toLowerCase();
      return { abs, mime: EXT_MIME[ext] || sniffMime(abs) };
    }
  }
  return null;
}

// ----------------------------------------------------------------- routes

router.get('/chats', (_req, res) => {
  res.json(chatList());
});

router.get('/messages', (req, res) => {
  const chat = String(req.query.chat || '');
  if (!chat) return res.status(400).json({ error: 'chat is required' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
  return res.json(messagesPage(chat, req.query.before ? String(req.query.before) : null, limit));
});

router.get('/media', (req, res) => {
  const key = String(req.query.key || '');
  const row = db
    .prepare(`SELECT media_on_disk, media_snapshot, media_file_id, media_rel_path, waha_media_state, waha_media_path, waha_media_mime
              FROM messages WHERE msg_key = ?`)
    .get(key);
  const found = row && mediaFor(row);
  if (!found) return res.status(404).json({ error: 'media not available' });
  res.set('Cache-Control', 'private, max-age=86400');
  // sendFile answers Range requests, which video and audio seeking needs.
  return res.sendFile(found.abs, { headers: { 'Content-Type': found.mime }, dotfiles: 'allow' });
});

// Folders under the backup root, with what the archiver does with each.
function backupFolders() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(cfg.backupRoot, { withFileTypes: true }); } catch (_) { return out; }
  const ios = new Set(discoverSnapshots(cfg.backupRoot));
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(cfg.backupRoot, e.name);
    let kind = 'other';
    if (ios.has(e.name)) kind = 'ios';
    else if (fs.existsSync(path.join(dir, 'archive.db'))) kind = 'archive';
    else {
      const looksAndroid = (d) => {
        try { return fs.readdirSync(d).some((f) => /^msgstore.*\.(db|crypt\d+)$/i.test(f)); } catch (_) { return false; }
      };
      if (looksAndroid(path.join(dir, 'Databases')) || looksAndroid(dir)) kind = 'android';
    }
    out.push({ name: e.name, kind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function statusInfo() {
  const n = (sql) => db.prepare(sql).get().n;
  const lastSync = db.prepare('SELECT status, started_at, finished_at, stats_json FROM sync_runs ORDER BY id DESC LIMIT 1').get();
  let lastStats = null;
  try { lastStats = lastSync && lastSync.stats_json ? JSON.parse(lastSync.stats_json) : null; } catch (_) { /* ignore */ }
  return {
    messages: n('SELECT COUNT(*) AS n FROM messages'),
    chats: n('SELECT COUNT(*) AS n FROM chats'),
    by_source: db.prepare('SELECT COALESCE(backup_kind, \'waha\') AS source, COUNT(*) AS n FROM messages GROUP BY COALESCE(backup_kind, \'waha\')').all(),
    waha_media: db.prepare("SELECT waha_media_state AS state, COUNT(*) AS n FROM messages WHERE waha_media_state IS NOT NULL GROUP BY waha_media_state").all(),
    oldest: db.prepare('SELECT MIN(ts) AS t FROM messages').get().t,
    newest: db.prepare('SELECT MAX(ts) AS t FROM messages').get().t,
    import: importState(),
    sync: {
      running: syncState.running,
      last_status: syncState.last_status,
      last_error: syncState.last_error,
      last_finished: syncState.last_finished,
      last_run: lastSync ? { status: lastSync.status, started_at: lastSync.started_at, finished_at: lastSync.finished_at } : null,
      last_stats: syncState.last_stats || lastStats,
    },
    media_job_running: mediaJob.running,
  };
}

router.get('/status', (_req, res) => res.json(statusInfo()));

router.get('/preferences', (_req, res) => {
  res.json({
    preferences: prefsStore.get(),
    options: prefsStore.OPTIONS,
    folders: backupFolders(),
    backup_root: cfg.backupRoot,
    logout_url: process.env.READER_LOGOUT_URL || '',
    status: statusInfo(),
  });
});

let onPrefsSaved = () => {};
router.post('/preferences', (req, res) => {
  try {
    const saved = prefsStore.save(req.body || {});
    invalidateChats();
    onPrefsSaved(saved);
    res.json({ preferences: saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------- actions

const mediaJob = { running: false };

router.post('/actions/:name', (req, res) => {
  const name = req.params.name;
  const busy = () => res.status(409).json({ error: 'Another job is already running. Try again when it has finished.' });
  if (name === 'import') {
    if (importState().running) return busy();
    runBackupImport().then(invalidateChats);
    return res.status(202).json({ started: 'backup import' });
  }
  if (name === 'sync' || name === 'full-sync') {
    if (syncState.running) return busy();
    runSync({ full: name === 'full-sync' }).then(invalidateChats).catch(() => {});
    return res.status(202).json({ started: name === 'sync' ? 'WAHA sync' : 'full WAHA resync' });
  }
  if (name === 'retry-media') {
    if (syncState.running || mediaJob.running) return busy();
    const reset = db.prepare("UPDATE messages SET waha_media_state = 'pending', waha_media_attempts = 0 WHERE waha_media_state = 'failed'").run().changes;
    mediaJob.running = true;
    processPendingMedia()
      .catch((e) => console.error(`[media] retry failed: ${e.message}`))
      .finally(() => { mediaJob.running = false; });
    return res.status(202).json({ started: `media retry (${reset} failed file(s) reset)` });
  }
  return res.status(404).json({ error: 'Unknown action' });
});

module.exports = {
  router,
  invalidateChats,
  setPrefsHook(fn) { onPrefsSaved = fn; },
};
