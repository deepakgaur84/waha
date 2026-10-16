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
const { avatarPath, syncAvatars, avatarState } = require('./avatars');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker', 'gif']);

// ---------------------------------------------------------------- helpers

// WAHA also reports the protocol messages behind edits and deletions as empty "system" rows. They are
// shown on the original message instead, so they are left out of the lists.
const NOT_NOISE = "NOT (m.source = 'waha' AND m.type = 'system' AND m.text IS NULL)";

function modeFilter() {
  const mode = prefsStore.get().reader_mode;
  if (mode === 'all') return { sql: NOT_NOISE, params: [] };
  return { sql: `${NOT_NOISE} AND (m.backup_kind IS NULL OR m.backup_kind = ?)`, params: [mode] };
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
  const prefs = prefsStore.get();
  const mode = prefs.reader_mode;
  // Chats whose id ends with one of the "skip" suffixes (Status updates, channels...) are hidden
  // from the list. The stored messages are not deleted.
  const hidden = (prefs.skip_chat_suffixes || []).map((x) => x.toLowerCase());
  const cacheKey = `${mode}|${hidden.join(',')}`;
  if (chatCache.value && chatCache.key === cacheKey && Date.now() - chatCache.at < 20000) return chatCache.value;
  const f = modeFilter();
  const rows = db
    .prepare(`SELECT m.chat_id AS chat_id, COUNT(*) AS n, MAX(m.ts) AS last_ts FROM messages m WHERE ${f.sql} GROUP BY m.chat_id ORDER BY last_ts DESC`)
    .all(...f.params);
  const meta = new Map(db.prepare('SELECT chat_id, kind, name FROM chats').all().map((c) => [c.chat_id, c]));
  const withPhoto = new Set(db.prepare("SELECT jid FROM avatars WHERE status = 'ok'").all().map((a) => a.jid));
  const value = rows.filter((r) => !hidden.some((suffix) => r.chat_id.toLowerCase().endsWith(suffix))).map((r) => {
    const c = meta.get(r.chat_id) || {};
    const isGroup = c.kind === 'group' || r.chat_id.endsWith('@g.us');
    return {
      id: r.chat_id,
      name: c.name || (isGroup ? 'Group' : numberFromJid(r.chat_id)),
      is_group: isGroup,
      label: isGroup ? 'Group' : numberFromJid(r.chat_id),
      last_date: r.last_ts,
      count: r.n,
      has_avatar: withPhoto.has(r.chat_id),
    };
  });
  chatCache = { key: cacheKey, at: Date.now(), value };
  return value;
}

// Messages are paged with a cursor "<ts>~<msg_key>" so several messages in the same second are never lost.
function parseCursor(cursor) {
  if (!cursor) return null;
  const i = cursor.indexOf('~');
  const ts = Number(cursor.slice(0, i));
  return i > 0 && Number.isFinite(ts) ? { ts, key: cursor.slice(i + 1) } : null;
}

const COLUMNS = `m.msg_key, m.stanza_id, m.ts, m.from_me, m.sender_jid, m.sender_name, m.type, m.text, m.media_title,
                 m.media_on_disk, m.waha_media_state, m.waha_media_path, m.edited_at`;

// direction 'before' (older than the cursor, newest first) or 'after' (newer than the cursor, oldest first).
function selectRows(chatId, cursor, limit, direction) {
  const f = modeFilter();
  let sql = `SELECT ${COLUMNS} FROM messages m WHERE m.chat_id = ? AND ${f.sql}`;
  const params = [chatId, ...f.params];
  const c = parseCursor(cursor);
  if (direction === 'after') {
    if (c) { sql += ' AND (m.ts > ? OR (m.ts = ? AND m.msg_key > ?))'; params.push(c.ts, c.ts, c.key); }
    sql += ' ORDER BY m.ts ASC, m.msg_key ASC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  }
  if (c) { sql += ' AND (m.ts < ? OR (m.ts = ? AND m.msg_key < ?))'; params.push(c.ts, c.ts, c.key); }
  sql += ' ORDER BY m.ts DESC, m.msg_key DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).reverse();
}

// Reactions, edit counts and deletions for a page of rows, looked up by message id.
function extras(rows) {
  const ids = [...new Set(rows.map((r) => r.stanza_id).filter(Boolean))];
  const reactions = new Map();
  const edits = new Map();
  const revoked = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const marks = chunk.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT stanza_id, emoji, reactor FROM message_reactions WHERE stanza_id IN (${marks})`).all(...chunk)) {
      if (!reactions.has(r.stanza_id)) reactions.set(r.stanza_id, new Map());
      const byEmoji = reactions.get(r.stanza_id);
      const e = byEmoji.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
      e.count += 1;
      if (r.reactor === 'me') e.mine = true;
      byEmoji.set(r.emoji, e);
    }
    for (const r of db.prepare(`SELECT stanza_id, COUNT(*) AS n FROM message_edits WHERE stanza_id IN (${marks}) GROUP BY stanza_id`).all(...chunk)) {
      edits.set(r.stanza_id, r.n);
    }
    for (const r of db.prepare(`SELECT stanza_id FROM message_revokes WHERE stanza_id IN (${marks})`).all(...chunk)) {
      revoked.add(r.stanza_id);
    }
  }
  return { reactions, edits, revoked };
}

function toMessages(rows) {
  const x = extras(rows);
  return rows.map((r) => {
    const isMedia = MEDIA_TYPES.has(r.type);
    const available = (r.waha_media_state === 'done' && r.waha_media_path) || r.media_on_disk === 1;
    const rx = r.stanza_id && x.reactions.get(r.stanza_id);
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
      edited: Boolean(r.edited_at),
      deleted: Boolean(r.stanza_id && x.revoked.has(r.stanza_id)),
      reactions: rx ? [...rx.values()].sort((a, b) => b.count - a.count) : [],
    };
  });
}

function messagesPage(chatId, cursor, limit, direction = 'before') {
  return toMessages(selectRows(chatId, cursor, limit, direction));
}

// A window of messages around one message (used when a search result is opened).
function messagesAround(chatId, key, each) {
  const f = modeFilter();
  const target = db
    .prepare(`SELECT ${COLUMNS} FROM messages m WHERE m.chat_id = ? AND m.msg_key = ? AND ${f.sql}`)
    .get(chatId, key, ...f.params);
  if (!target) return null;
  const cursor = `${target.ts}~${target.msg_key}`;
  const older = selectRows(chatId, cursor, each, 'before');
  const newer = selectRows(chatId, cursor, each, 'after');
  return {
    messages: toMessages([...older, target, ...newer]),
    no_more_older: older.length < each,
    has_newer: newer.length === each,
  };
}

// Every stored version of an edited message, oldest first.
function editHistory(chatId, key) {
  const row = db.prepare('SELECT stanza_id FROM messages WHERE chat_id = ? AND msg_key = ?').get(chatId, key);
  if (!row || !row.stanza_id) return [];
  return db
    .prepare('SELECT ts AS date, text FROM message_edits WHERE stanza_id = ? ORDER BY ts')
    .all(row.stanza_id);
}

// ------------------------------------------------------------------ search

function likeEscape(s) { return s.replace(/[\\%_]/g, (c) => `\\${c}`); }

function searchMessages(q, chatId, limit, offset) {
  const tokens = String(q || '').match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return { results: [], more: false };
  // Every word must appear; the words may be partial ("birth" finds "birthday").
  const match = tokens.slice(0, 8).map((t) => `"${t}"*`).join(' ');
  const f = modeFilter();
  const hidden = (prefsStore.get().skip_chat_suffixes || []).map((x) => x.toLowerCase());
  let sql = `SELECT m.msg_key, m.chat_id, m.ts, m.from_me, m.type,
                    snippet(messages_fts, -1, char(1), char(2), '…', 14) AS snip
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ? AND ${f.sql}`;
  const params = [match, ...f.params];
  if (chatId) { sql += ' AND m.chat_id = ?'; params.push(chatId); }
  for (const suffix of hidden) {
    sql += " AND lower(m.chat_id) NOT LIKE ? ESCAPE '\\'";
    params.push(`%${likeEscape(suffix)}`);
  }
  sql += ' ORDER BY m.ts DESC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset);
  let rows;
  try {
    rows = db.prepare(sql).all(...params);
  } catch (e) {
    return { results: [], more: false, error: 'That search could not be run.' };
  }
  const more = rows.length > limit;
  const names = new Map(chatList().map((c) => [c.id, c]));
  return {
    more,
    results: rows.slice(0, limit).map((r) => {
      const c = names.get(r.chat_id) || {};
      return {
        id: r.msg_key,
        chat_id: r.chat_id,
        chat_name: c.name || numberFromJid(r.chat_id),
        date: r.ts,
        is_from_me: r.from_me === 1,
        snippet: r.snip,
      };
    }),
  };
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
  if (req.query.after) return res.json(messagesPage(chat, String(req.query.after), limit, 'after'));
  return res.json(messagesPage(chat, req.query.before ? String(req.query.before) : null, limit));
});

router.get('/messages/around', (req, res) => {
  const chat = String(req.query.chat || '');
  const key = String(req.query.key || '');
  if (!chat || !key) return res.status(400).json({ error: 'chat and key are required' });
  const found = messagesAround(chat, key, 40);
  if (!found) return res.status(404).json({ error: 'That message is not available in the current reader mode.' });
  return res.json(found);
});

router.get('/messages/edits', (req, res) => {
  res.json(editHistory(String(req.query.chat || ''), String(req.query.key || '')));
});

router.get('/search', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json(searchMessages(req.query.q, req.query.chat ? String(req.query.chat) : null, limit, offset));
});

router.get('/avatar', (req, res) => {
  const abs = avatarPath(String(req.query.jid || ''));
  if (!abs) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  return res.type('image/jpeg').sendFile(abs, { dotfiles: 'allow' });
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
    avatars: {
      enabled: prefsStore.get().fetch_avatars,
      running: avatarState.running,
      done: avatarState.done,
      total: avatarState.total,
      with_photo: n("SELECT COUNT(*) AS n FROM avatars WHERE status = 'ok'"),
      without_photo: n("SELECT COUNT(*) AS n FROM avatars WHERE status = 'none'"),
      not_checked: Math.max(0, n('SELECT COUNT(DISTINCT chat_id) AS n FROM messages') - n('SELECT COUNT(*) AS n FROM avatars')),
      last_finished: avatarState.last_finished,
      last_stats: avatarState.last_stats,
      last_errors: avatarState.last_errors,
    },
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
  if (name === 'avatars') {
    if (avatarState.running) return busy();
    db.prepare("UPDATE avatars SET checked_at = 0").run(); // look at every chat again
    syncAvatars().then(invalidateChats).catch(() => {});
    return res.status(202).json({ started: 'profile photo refresh' });
  }
  return res.status(404).json({ error: 'Unknown action' });
});

module.exports = {
  router,
  invalidateChats,
  setPrefsHook(fn) { onPrefsSaved = fn; },
};
