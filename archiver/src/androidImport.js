// Imports a decrypted Android WhatsApp backup (msgstore.db) into the archive database.
//
// A backup folder is recognised by the database inside it, in the phone's own layout
//   <folder>/Databases/msgstore.db.crypt15   (end-to-end encrypted backup: decrypted here with
//                                             the key file named by ANDROID_KEY_FILE)
//   <folder>/Databases/msgstore.db           (an already decrypted copy wins when present)
// (or the same files directly in <folder>). Media files are read from <folder>/Media/..., the
// paths stored in the database are relative to <folder>. Folders are only read, never changed:
// the database is copied or decrypted into a temporary file first, which is deleted afterwards.
// crypt14 backups need the key file from the phone itself and are not supported: make a crypt15
// (end-to-end encrypted) backup instead.
//
// Layout facts below were checked against a real msgstore.db (WhatsApp 2.26.40.76); every table
// and column that is not essential is optional, so a different WhatsApp version degrades
// (fewer details) instead of failing.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');
const { db } = require('./db');
const { decryptCrypt15 } = require('./crypt15');

// Labels for message_type. raw_type is stored too, so a label can be corrected without re-importing.
const ANDROID_TYPES = {
  0: 'text', 1: 'image', 2: 'audio', 3: 'video', 4: 'contact', 5: 'location',
  7: 'system', 9: 'document', 13: 'gif', 15: 'deleted', 20: 'sticker',
};

// Chats on these servers are not conversations (status updates, bots, the account itself).
const SKIP_SERVERS = new Set(['broadcast', 'bot', 'status_me', 'lid_me', 'temp', 'newsletter']);

function normJid(jid) {
  if (!jid) return null;
  return String(jid).replace(/@s\.whatsapp\.net$/, '@c.us');
}

// Which database file a folder offers: { kind: 'plain' | 'crypt15' | 'crypt14', file } or null.
function androidSource(dir) {
  for (const d of [path.join(dir, 'Databases'), dir]) {
    const plain = path.join(d, 'msgstore.db');
    if (fs.existsSync(plain)) return { kind: 'plain', file: plain };
  }
  for (const [ext, kind] of [['.crypt15', 'crypt15'], ['.crypt14', 'crypt14']]) {
    for (const d of [path.join(dir, 'Databases'), dir]) {
      let names = [];
      try { names = fs.readdirSync(d); } catch (_) { continue; }
      const main = names.find((n) => n === `msgstore.db${ext}`);
      // Dated daily copies are the fallback; "increment" files are partial and never used alone.
      const dated = names.filter((n) => /^msgstore-\d{4}-\d{2}-\d{2}\.\d+\.db/.test(n) && n.endsWith(ext)).sort().pop();
      const pick = main || dated;
      if (pick) return { kind, file: path.join(d, pick) };
    }
  }
  return null;
}

// Folder names that hold an Android backup database (decrypted or not), oldest name first.
function discoverAndroidSnapshots(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  return entries
    .filter((e) => e.isDirectory() && androidSource(path.join(root, e.name)))
    .map((e) => e.name)
    .sort();
}

const upsertMessage = db.prepare(`
  INSERT INTO messages
    (msg_key, chat_id, stanza_id, id_source, from_me, sender_jid, sender_name,
     ts, type, raw_type, text, starred, source, first_snapshot, backup_kind, edited_at,
     media_snapshot, media_rel_path, media_file_id, media_title, media_size, media_on_disk)
  VALUES
    (@msg_key, @chat_id, @stanza_id, 'stanza', @from_me, @sender_jid, NULL,
     @ts, @type, @raw_type, @text, @starred, 'backup', @snapshot, 'android', @edited_at,
     @media_snapshot, @media_rel_path, NULL, @media_title, @media_size, @media_on_disk)
  ON CONFLICT(msg_key) DO UPDATE SET
    backup_kind = COALESCE(messages.backup_kind, 'android'),
    text = CASE WHEN excluded.edited_at IS NOT NULL THEN excluded.text ELSE messages.text END,
    edited_at = COALESCE(excluded.edited_at, messages.edited_at),
    media_snapshot = CASE WHEN messages.media_rel_path IS NULL THEN excluded.media_snapshot ELSE messages.media_snapshot END,
    media_rel_path = COALESCE(messages.media_rel_path, excluded.media_rel_path),
    media_on_disk = CASE WHEN excluded.media_on_disk = 1 THEN 1 ELSE messages.media_on_disk END
`);

const upsertChat = db.prepare(`
  INSERT INTO chats (chat_id, kind, name) VALUES (@chat_id, @kind, @name)
  ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(excluded.name, chats.name), kind = excluded.kind
`);

const setReaction = db.prepare(`
  INSERT INTO message_reactions (stanza_id, reactor, emoji, ts) VALUES (?, ?, ?, ?)
  ON CONFLICT(stanza_id, reactor) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts
  WHERE excluded.ts >= message_reactions.ts`);
const insertEdit = db.prepare('INSERT OR IGNORE INTO message_edits (stanza_id, ts, text) VALUES (?, ?, ?)');
const insertRevoke = db.prepare('INSERT OR IGNORE INTO message_revokes (stanza_id, ts) VALUES (?, ?)');

function hasTable(adb, name) {
  return !!adb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}
function columnsOf(adb, name) {
  return new Set(adb.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name));
}

function seconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n > 1e11 ? n / 1000 : n);
}

async function importAndroidSnapshot(root, name) {
  const snapDir = path.join(root, name);
  const t0 = Date.now();
  const stats = {
    snapshot: name, kind: 'android',
    chats: 0, messages_read: 0, new_messages: 0,
    skipped_no_chat: 0, skipped_no_date: 0, skipped_system_or_empty: 0,
    deleted_markers: 0, edited: 0, reactions: 0,
    media_refs: 0, media_on_disk: 0, seconds: 0,
  };

  const source = androidSource(snapDir);
  if (!source) throw new Error('no msgstore database in this folder');
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  const tmp = path.join(cfg.tmpDir, `${name}.msgstore.db`);
  try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  stats.source_file = path.basename(source.file);
  if (source.kind === 'plain') {
    fs.copyFileSync(source.file, tmp);
  } else if (source.kind === 'crypt15') {
    if (!cfg.androidKeyFile) throw new Error(`${stats.source_file} is encrypted: set ANDROID_KEY_FILE to a file holding the 64-digit key`);
    try {
      await decryptCrypt15(source.file, tmp, cfg.androidKeyFile);
    } catch (e) {
      throw new Error(`could not decrypt ${stats.source_file}: ${e.message}`);
    }
    stats.decrypted = true;
  } else {
    throw new Error(`${stats.source_file} is a crypt14 backup, which needs the key file from the phone. Turn on end-to-end encrypted backup in WhatsApp and make a new backup (crypt15).`);
  }

  const adb = new Database(tmp, { fileMustExist: true, readonly: true });
  try {
    for (const t of ['message', 'chat', 'jid']) {
      if (!hasTable(adb, t)) throw new Error(`table "${t}" not found - is this a decrypted msgstore.db?`);
    }
    const mCols = columnsOf(adb, 'message');
    for (const c of ['_id', 'chat_row_id', 'from_me', 'key_id', 'timestamp', 'message_type']) {
      if (!mCols.has(c)) throw new Error(`message.${c} not found (unsupported WhatsApp version)`);
    }

    // ---- who is who ------------------------------------------------------
    const jids = new Map();
    for (const j of adb.prepare('SELECT _id, user, server, raw_string FROM jid').all()) jids.set(j._id, j);
    const lidToPn = new Map(); // a LID row -> the phone-number row it belongs to
    if (hasTable(adb, 'jid_map')) {
      for (const r of adb.prepare('SELECT lid_row_id, jid_row_id FROM jid_map').all()) lidToPn.set(r.lid_row_id, r.jid_row_id);
    }
    const jidOf = (rowId) => {
      let j = jids.get(rowId);
      if (!j) return null;
      if (j.server === 'lid' && lidToPn.has(rowId)) j = jids.get(lidToPn.get(rowId)) || j;
      return normJid(j.raw_string || (j.user ? `${j.user}@${j.server}` : null));
    };

    const chatById = new Map();
    for (const c of adb.prepare('SELECT _id, jid_row_id, subject FROM chat').all()) {
      const raw = jids.get(c.jid_row_id);
      if (!raw || SKIP_SERVERS.has(raw.server)) continue;
      const id = jidOf(c.jid_row_id);
      if (!id) continue;
      const kind = raw.server === 'g.us' ? 'group' : 'private';
      const nm = c.subject && String(c.subject).trim() ? String(c.subject).trim() : null;
      chatById.set(c._id, { id, kind, name: kind === 'group' ? nm : null });
    }

    // ---- messages --------------------------------------------------------
    const hasMedia = hasTable(adb, 'message_media');
    const hasEdit = hasTable(adb, 'message_edit_info');
    const hasRevoked = hasTable(adb, 'message_revoked');
    const sql = `
      SELECT m._id AS rid, m.chat_row_id AS chat, m.from_me AS fromme, m.key_id AS key_id,
             ${mCols.has('sender_jid_row_id') ? 'm.sender_jid_row_id' : 'NULL'} AS sender,
             m.timestamp AS ts, m.message_type AS t,
             ${mCols.has('text_data') ? 'm.text_data' : 'NULL'} AS text,
             ${mCols.has('starred') ? 'm.starred' : '0'} AS starred,
             ${hasMedia ? 'mm.message_row_id' : 'NULL'} AS has_media,
             ${hasMedia ? 'mm.file_path' : 'NULL'} AS mpath,
             ${hasMedia ? 'mm.media_name' : 'NULL'} AS mname,
             ${hasMedia ? 'mm.file_size' : 'NULL'} AS msize,
             ${hasMedia ? 'mm.mime_type' : 'NULL'} AS mime,
             ${hasMedia ? 'mm.media_caption' : 'NULL'} AS caption,
             ${hasEdit ? 'e.original_key_id' : 'NULL'} AS orig_key,
             ${hasEdit ? 'e.edited_timestamp' : 'NULL'} AS edited_ts,
             ${hasRevoked ? 'r.revoked_key_id' : 'NULL'} AS revoked_key,
             ${hasRevoked ? 'r.revoke_timestamp' : 'NULL'} AS revoke_ts
      FROM message m
      ${hasMedia ? 'LEFT JOIN message_media mm ON mm.message_row_id = m._id' : ''}
      ${hasEdit ? 'LEFT JOIN message_edit_info e ON e.message_row_id = m._id' : ''}
      ${hasRevoked ? 'LEFT JOIN message_revoked r ON r.message_row_id = m._id' : ''}
      ORDER BY m._id`;

    const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const stanzaOfRow = new Map(); // message._id -> { stanza, chatJid } (for reactions)

    const run = db.transaction(() => {
      for (const c of chatById.values()) upsertChat.run({ chat_id: c.id, kind: c.kind, name: c.name });
      stats.chats = chatById.size;

      for (const r of adb.prepare(sql).iterate()) {
        stats.messages_read += 1;
        const chat = chatById.get(r.chat);
        if (!chat) { stats.skipped_no_chat += 1; continue; }
        const ts = seconds(r.ts);
        if (!ts) { stats.skipped_no_date += 1; continue; }
        if (!r.key_id) { stats.skipped_system_or_empty += 1; continue; }

        const fromMe = r.fromme ? 1 : 0;
        let senderJid = null;
        if (!fromMe) senderJid = (r.sender ? jidOf(r.sender) : null) || (chat.kind === 'private' ? chat.id : null);

        let stanza = String(r.key_id).trim().toUpperCase();
        let type = ANDROID_TYPES[r.t] || null;
        if (!type) {
          // A type number this importer does not know: use the media's mime type when there is one.
          const m = r.mime ? String(r.mime).split('/')[0] : '';
          type = ['image', 'video', 'audio'].includes(m) ? m : (r.has_media ? 'document' : `other_${r.t}`);
        }
        let text = r.text && String(r.text) !== '' ? String(r.text) : (r.caption ? String(r.caption) : null);
        let editedAt = null;

        if (r.t === 15) {
          // A deleted message: Android keeps only a marker; the original id is in message_revoked.
          if (!r.revoked_key) { stats.skipped_system_or_empty += 1; continue; }
          stanza = String(r.revoked_key).trim().toUpperCase();
          type = 'deleted';
          text = null;
          insertRevoke.run(stanza, seconds(r.revoke_ts) || ts);
          stats.deleted_markers += 1;
        } else if (!text && !r.has_media) {
          // System notices ("X joined"), calls and other rows with nothing to show.
          stats.skipped_system_or_empty += 1;
          continue;
        } else if (r.orig_key) {
          // An edited message: the row holds the newest text; the id everyone else knows is the original.
          stanza = String(r.orig_key).trim().toUpperCase();
          editedAt = seconds(r.edited_ts) || ts;
          stats.edited += 1;
        }

        let onDisk = 0;
        if (r.mpath) {
          stats.media_refs += 1;
          const abs = path.join(snapDir, r.mpath);
          const base = path.resolve(snapDir) + path.sep;
          if (path.resolve(abs).startsWith(base) && fs.existsSync(abs)) { onDisk = 1; stats.media_on_disk += 1; }
        }

        upsertMessage.run({
          msg_key: `${chat.id}|${stanza}`,
          chat_id: chat.id,
          stanza_id: stanza,
          from_me: fromMe,
          sender_jid: senderJid,
          ts,
          type,
          raw_type: r.t === null || r.t === undefined ? null : r.t,
          text,
          starred: r.starred ? 1 : 0,
          snapshot: name,
          edited_at: editedAt,
          media_snapshot: r.mpath ? name : null,
          media_rel_path: r.mpath || null,
          media_title: r.mname || null,
          media_size: r.msize === undefined ? null : r.msize,
          media_on_disk: onDisk,
        });
        if (editedAt && text) insertEdit.run(stanza, editedAt, text);
        stanzaOfRow.set(r.rid, { stanza, chatJid: chat.id });
      }

      // ---- reactions -----------------------------------------------------
      if (hasTable(adb, 'message_add_on') && hasTable(adb, 'message_add_on_reaction')) {
        const rows = adb.prepare(`
          SELECT a.parent_message_row_id AS parent, a.from_me AS fromme, a.sender_jid_row_id AS sender,
                 a.timestamp AS ts, x.reaction AS emoji, x.sender_timestamp AS sts
          FROM message_add_on a JOIN message_add_on_reaction x ON x.message_add_on_row_id = a._id
          WHERE a.message_add_on_type = 56`).all();
        for (const a of rows) {
          const parent = stanzaOfRow.get(a.parent);
          if (!parent || !a.emoji) continue;
          const reactor = a.fromme ? 'me' : (a.sender ? jidOf(a.sender) : null) || parent.chatJid || 'unknown';
          setReaction.run(parent.stanza, reactor, a.emoji, seconds(a.sts) || seconds(a.ts) || 0);
          stats.reactions += 1;
        }
      }
    });
    run();

    stats.new_messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n - before;
  } finally {
    try { adb.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }

  stats.seconds = Math.round((Date.now() - t0) / 1000);
  return stats;
}

module.exports = { discoverAndroidSnapshots, importAndroidSnapshot, androidSource };
