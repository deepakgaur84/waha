// Stage 1: import iOS WhatsApp backup snapshots into the archive database.
//
// Reads each snapshot's ChatStorage.sqlite straight from the backup (found
// through the snapshot's own Manifest.db). The backup folders are only read,
// never changed: the database files are copied into a temp folder first.
//
// Safe to re-run: a snapshot that was imported successfully is skipped
// (unless FORCE_REIMPORT=true), and messages are keyed on WhatsApp's own
// message id (ZSTANZAID), so overlapping snapshots never create duplicates.
//
// Run by hand:   node src/backupImport.js
// Normally started by server.js in a separate process.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const cfg = require('./config');
const { db } = require('./db');
const prefsStore = require('./prefs');

const MAC_EPOCH = 978307200; // Core Data / Mac absolute time -> unix seconds

// Same mapping the wa-reader uses. raw_type is always stored as well, so
// this label can be corrected later without re-importing.
const MESSAGE_TYPES = {
  0: 'text', 1: 'image', 2: 'video', 3: 'audio', 4: 'contact',
  5: 'location', 8: 'sticker', 9: 'document', 13: 'gif', 14: 'sticker',
};

const OPAQUE_TOKEN_RE = /^[A-Za-z0-9+/]+=+$/; // base64-looking junk in name fields

function log(msg) {
  console.log(`[import ${new Date().toISOString()}] ${msg}`);
}

// iOS stores people as ...@s.whatsapp.net, WAHA calls the same thing ...@c.us.
function normJid(jid) {
  if (!jid) return null;
  return String(jid).replace(/@s\.whatsapp\.net$/, '@c.us');
}

function goodName(name) {
  if (!name) return null;
  const n = String(name).trim();
  if (!n || OPAQUE_TOKEN_RE.test(n)) return null;
  return n;
}

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------- snapshots

function discoverSnapshots(root) {
  if (!fs.existsSync(root)) {
    throw new Error(`BACKUP_ROOT ${root} does not exist inside the container`);
  }
  const found = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'Manifest.db')))
    .map((e) => e.name);

  // Oldest first. Folder names contain a 14-digit timestamp, e.g. ..._20260720151456_WhatsApp
  const stamp = (name) => {
    const m = name.match(/(\d{14})/);
    return m ? m[1] : '';
  };
  return found.sort((a, b) => stamp(a).localeCompare(stamp(b)) || a.localeCompare(b));
}

function copyToTmp(src, name) {
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  const dst = path.join(cfg.tmpDir, name);
  fs.copyFileSync(src, dst);
  return dst;
}

function removeQuiet(...files) {
  for (const f of files) {
    try { fs.rmSync(f, { force: true }); } catch (_) { /* ignore */ }
  }
}

function backupFile(snapDir, fileId) {
  return path.join(snapDir, fileId.slice(0, 2), fileId);
}

// ------------------------------------------------------------ media lookup

function buildMediaIndex(rows) {
  const exact = new Map();
  const byBase = new Map();
  const byStem = new Map();
  for (const r of rows) {
    exact.set(r.relativePath, r.fileID);
    const base = r.relativePath.split('/').pop();
    if (!byBase.has(base)) byBase.set(base, r.fileID);
    const stem = base.replace(/\.[^.]*$/, '');
    if (!byStem.has(stem)) byStem.set(stem, r.fileID);
  }
  return {
    resolve(rel) {
      const stripped = rel.replace(/^\/+/, '');
      for (const c of [rel, stripped, `Message/${rel}`, `Message/${stripped}`]) {
        if (exact.has(c)) return exact.get(c);
      }
      const base = stripped.split('/').pop();
      // stored path sometimes lacks the extension the backed-up file has
      return byBase.get(base) || byStem.get(base) || null;
    },
  };
}

// ---------------------------------------------------------------- statements

const MEDIA_COLS = [
  'media_snapshot', 'media_rel_path', 'media_file_id',
  'media_title', 'media_size', 'media_on_disk',
];
// Fill media details on an existing row only when it has none yet, or only
// now found the file on disk. (In SQLite every right-hand side in one UPDATE
// reads the OLD row, so these conditions are consistent across columns.)
const FILL_MEDIA = `(messages.media_on_disk = 0 AND excluded.media_on_disk = 1)
  OR (messages.media_rel_path IS NULL AND excluded.media_rel_path IS NOT NULL)`;

const upsertMessage = db.prepare(`
  INSERT INTO messages
    (msg_key, chat_id, stanza_id, id_source, from_me, sender_jid, sender_name,
     ts, type, raw_type, text, starred, source, first_snapshot,
     media_snapshot, media_rel_path, media_file_id, media_title, media_size, media_on_disk)
  VALUES
    (@msg_key, @chat_id, @stanza_id, @id_source, @from_me, @sender_jid, @sender_name,
     @ts, @type, @raw_type, @text, @starred, 'backup', @snapshot,
     @media_snapshot, @media_rel_path, @media_file_id, @media_title, @media_size, @media_on_disk)
  ON CONFLICT(msg_key) DO UPDATE SET
    sender_name = COALESCE(messages.sender_name, excluded.sender_name),
    ${MEDIA_COLS.map((c) => `${c} = CASE WHEN ${FILL_MEDIA} THEN excluded.${c} ELSE messages.${c} END`).join(',\n    ')}
`);

const upsertChat = db.prepare(`
  INSERT INTO chats (chat_id, kind, name) VALUES (@chat_id, @kind, @name)
  ON CONFLICT(chat_id) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    kind = excluded.kind
`);

// -------------------------------------------------------------- one snapshot

function importSnapshot(root, name) {
  const snapDir = path.join(root, name);
  const t0 = Date.now();
  const stats = {
    snapshot: name,
    chats: 0,
    chats_without_jid: 0,
    messages_read: 0,
    new_messages: 0,
    no_stanza_id: 0,
    skipped_no_chat: 0,
    skipped_no_date: 0,
    media_refs: 0,
    media_on_disk: 0,
    wal_present: false,
    seconds: 0,
  };

  const tmpManifest = copyToTmp(path.join(snapDir, 'Manifest.db'), `${name}.Manifest.db`);
  const manifest = new Database(tmpManifest, { fileMustExist: true });
  let tmpChat = null;
  let chatDb = null;

  try {
    const files = manifest
      .prepare("SELECT fileID, relativePath FROM Files WHERE domain LIKE '%whatsapp%' COLLATE NOCASE")
      .all();
    const chatEntry = files.find((f) => f.relativePath === 'ChatStorage.sqlite');
    if (!chatEntry) throw new Error('ChatStorage.sqlite not listed in Manifest.db');
    const chatSrc = backupFile(snapDir, chatEntry.fileID);
    if (!fs.existsSync(chatSrc)) throw new Error(`ChatStorage.sqlite listed but missing on disk (${chatSrc})`);

    const media = buildMediaIndex(files);

    // Copy the chat database (and its write-ahead log, if the backup has one).
    tmpChat = path.join(cfg.tmpDir, `${name}.ChatStorage.sqlite`);
    const walEntry = files.find((f) => f.relativePath === 'ChatStorage.sqlite-wal');
    const walSrc = walEntry ? backupFile(snapDir, walEntry.fileID) : null;
    fs.mkdirSync(cfg.tmpDir, { recursive: true });
    removeQuiet(tmpChat, `${tmpChat}-wal`, `${tmpChat}-shm`);
    fs.copyFileSync(chatSrc, tmpChat);
    if (walSrc && fs.existsSync(walSrc)) {
      fs.copyFileSync(walSrc, `${tmpChat}-wal`);
      stats.wal_present = true;
    }
    try {
      chatDb = new Database(tmpChat, { fileMustExist: true });
      chatDb.prepare('SELECT COUNT(*) FROM ZWAMESSAGE').get();
    } catch (e) {
      if (!stats.wal_present) throw e;
      // a stale/mismatched log can make the copy unreadable: retry without it
      log(`${name}: could not read with the write-ahead log (${e.message}); retrying without it`);
      try { chatDb && chatDb.close(); } catch (_) { /* ignore */ }
      removeQuiet(`${tmpChat}-wal`, `${tmpChat}-shm`);
      stats.wal_present = false;
      chatDb = new Database(tmpChat, { fileMustExist: true });
    }

    // Lookup tables -------------------------------------------------------
    const sessions = chatDb
      .prepare('SELECT Z_PK AS pk, ZCONTACTJID AS jid, ZPARTNERNAME AS name, ZSESSIONTYPE AS stype FROM ZWACHATSESSION')
      .all();
    const chatBySession = new Map();
    for (const s of sessions) {
      if (s.stype === 3) continue; // "status" bookkeeping rows, not real chats
      const chatId = normJid(s.jid);
      if (!chatId) { stats.chats_without_jid += 1; continue; }
      let kind = 'private';
      if (s.stype === 1 || chatId.endsWith('@g.us')) kind = 'group';
      else if (s.stype === 2 || chatId.endsWith('@broadcast')) kind = 'broadcast';
      chatBySession.set(s.pk, { id: chatId, kind, name: goodName(s.name) });
    }

    const members = new Map(); // ZWAGROUPMEMBER.Z_PK -> { jid, name }
    try {
      for (const m of chatDb.prepare('SELECT Z_PK AS pk, ZMEMBERJID AS jid, ZCONTACTNAME AS name, ZFIRSTNAME AS first FROM ZWAGROUPMEMBER').all()) {
        members.set(m.pk, { jid: normJid(m.jid), name: goodName(m.name) || goodName(m.first) });
      }
    } catch (_) { /* table missing in some versions */ }

    const pushnames = new Map(); // normalised jid -> push name
    try {
      for (const p of chatDb.prepare('SELECT ZJID AS jid, ZPUSHNAME AS name FROM ZWAPROFILEPUSHNAME').all()) {
        const n = goodName(p.name);
        if (p.jid && n) pushnames.set(normJid(p.jid), n);
      }
    } catch (_) { /* table missing in some versions */ }

    // Everything for this snapshot goes in one transaction: all or nothing.
    const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

    const run = db.transaction(() => {
      for (const c of chatBySession.values()) {
        upsertChat.run({ chat_id: c.id, kind: c.kind, name: c.name });
      }
      stats.chats = chatBySession.size;

      const rows = chatDb.prepare(`
        SELECT m.ZCHATSESSION AS cs, m.ZSTANZAID AS stanza, m.ZISFROMME AS fromme,
               m.ZFROMJID AS fromjid, m.ZGROUPMEMBER AS gm, m.ZMESSAGEDATE AS d,
               m.ZMESSAGETYPE AS t, m.ZTEXT AS text, m.ZPUSHNAME AS pn, m.ZSTARRED AS starred,
               mi.ZMEDIALOCALPATH AS mpath, mi.ZTITLE AS mtitle, mi.ZFILESIZE AS msize
        FROM ZWAMESSAGE m
        LEFT JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK
        ORDER BY m.Z_PK
      `).iterate();

      for (const r of rows) {
        stats.messages_read += 1;
        const chat = chatBySession.get(r.cs);
        if (!chat) { stats.skipped_no_chat += 1; continue; }
        if (r.d === null || r.d === undefined) { stats.skipped_no_date += 1; continue; }

        const ts = Math.round(r.d + MAC_EPOCH);
        const fromMe = r.fromme ? 1 : 0;

        // In a group, ZFROMJID is the group itself; the real sender is the member.
        let senderJid = null;
        let memberName = null;
        if (!fromMe) {
          if (chat.kind === 'group') {
            const mem = members.get(r.gm);
            senderJid = mem ? mem.jid : null;
            memberName = mem ? mem.name : null;
          } else {
            senderJid = normJid(r.fromjid);
          }
        }
        const senderName = fromMe
          ? null
          : goodName(r.pn) || memberName || (senderJid ? pushnames.get(senderJid) : null) || null;

        const stanza = r.stanza ? String(r.stanza).trim().toUpperCase() : null;
        let msgKey;
        let idSource;
        if (stanza) {
          msgKey = `${chat.id}|${stanza}`;
          idSource = 'stanza';
        } else {
          stats.no_stanza_id += 1;
          const h = sha([chat.id, ts, fromMe, senderJid || '', r.t, r.text || ''].join('|')).slice(0, 32);
          msgKey = `${chat.id}|bk:${h}`;
          idSource = 'synthetic';
        }

        let mediaFileId = null;
        let mediaOnDisk = 0;
        if (r.mpath) {
          stats.media_refs += 1;
          mediaFileId = media.resolve(r.mpath);
          if (mediaFileId && fs.existsSync(backupFile(snapDir, mediaFileId))) {
            mediaOnDisk = 1;
            stats.media_on_disk += 1;
          }
        }

        upsertMessage.run({
          msg_key: msgKey,
          chat_id: chat.id,
          stanza_id: stanza,
          id_source: idSource,
          from_me: fromMe,
          sender_jid: senderJid,
          sender_name: senderName,
          ts,
          type: MESSAGE_TYPES[r.t] || `other_${r.t}`,
          raw_type: r.t === null || r.t === undefined ? null : r.t,
          text: r.text === undefined ? null : r.text,
          starred: r.starred ? 1 : 0,
          snapshot: name,
          media_snapshot: r.mpath ? name : null,
          media_rel_path: r.mpath || null,
          media_file_id: mediaFileId,
          media_title: r.mtitle || null,
          media_size: r.msize === undefined ? null : r.msize,
          media_on_disk: mediaOnDisk,
        });
      }
    });
    run();

    stats.new_messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n - before;
  } finally {
    try { chatDb && chatDb.close(); } catch (_) { /* ignore */ }
    manifest.close();
    removeQuiet(tmpManifest);
    if (tmpChat) removeQuiet(tmpChat, `${tmpChat}-wal`, `${tmpChat}-shm`);
  }

  stats.seconds = Math.round((Date.now() - t0) / 1000);
  return stats;
}

// -------------------------------------------------------------------- report

function buildReport(snapshotStats, probes) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const range = db.prepare('SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM messages').get();
  const byYear = db
    .prepare("SELECT strftime('%Y', ts, 'unixepoch') AS y, COUNT(*) AS n FROM messages GROUP BY y ORDER BY y")
    .all();
  const byKind = db
    .prepare('SELECT c.kind AS kind, COUNT(DISTINCT c.chat_id) AS chats FROM chats c GROUP BY c.kind')
    .all();
  const synthetic = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id_source = 'synthetic'").get().n;
  const mediaRows = db.prepare('SELECT COUNT(*) AS refs, SUM(media_on_disk) AS on_disk FROM messages WHERE media_rel_path IS NOT NULL').get();

  const probeRows = probes.map((id) => {
    const rows = db
      .prepare('SELECT chat_id, ts, from_me, type, first_snapshot FROM messages WHERE stanza_id = ?')
      .all(id);
    return {
      stanza_id: id,
      found: rows.length > 0,
      matches: rows.map((r) => ({
        chat_id: r.chat_id,
        time_utc: new Date(r.ts * 1000).toISOString(),
        from_me: !!r.from_me,
        type: r.type,
        first_snapshot: r.first_snapshot,
      })),
    };
  });

  return {
    generated_at: new Date().toISOString(),
    totals: {
      messages: total,
      oldest_utc: range.lo ? new Date(range.lo * 1000).toISOString() : null,
      newest_utc: range.hi ? new Date(range.hi * 1000).toISOString() : null,
      messages_without_stanza_id: synthetic,
      media_references: mediaRows.refs || 0,
      media_files_found_in_backup: mediaRows.on_disk || 0,
    },
    chats_by_kind: byKind,
    messages_by_year: byYear,
    snapshots: snapshotStats,
    probes: probeRows,
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(cfg.reportPath), { recursive: true });
  const tmp = `${cfg.reportPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, cfg.reportPath);
}

// ------------------------------------------------------------------- driver

function runImport() {
  const prefs = prefsStore.get(); // read fresh: a change in the reader applies to the next run
  let snapshots = discoverSnapshots(cfg.backupRoot);
  log(`Found ${snapshots.length} snapshot(s) under ${cfg.backupRoot}: ${snapshots.join(', ')}`);
  const excluded = prefs.excluded_backup_folders || [];
  if (excluded.length) {
    const skipped = snapshots.filter((s) => excluded.includes(s));
    if (skipped.length) log(`Excluded by preference, not read: ${skipped.join(', ')}`);
    snapshots = snapshots.filter((s) => !excluded.includes(s));
  }

  const doneBefore = new Map(
    db.prepare("SELECT snapshot, stats_json FROM import_runs WHERE status = 'done'").all()
      .map((r) => [r.snapshot, r.stats_json ? JSON.parse(r.stats_json) : null])
  );

  if (prefs.backup_import_mode === 'latest' && snapshots.length > 1) {
    const newest = snapshots[snapshots.length - 1];
    log(`Import mode is "latest" (Preferences): backups are cumulative, so only ${newest} is considered`);
    snapshots = [newest];
  }

  const allStats = [];
  // Keep the earlier imports visible in the report even when they are not touched this run.
  for (const [name, stats] of doneBefore) {
    if (!snapshots.includes(name) && stats) allStats.push({ ...stats, skipped: true });
  }
  for (const name of snapshots) {
    if (doneBefore.has(name) && !cfg.forceReimport) {
      log(`${name}: already imported, skipping (set FORCE_REIMPORT=true to redo)`);
      if (doneBefore.get(name)) allStats.push({ ...doneBefore.get(name), skipped: true });
      continue;
    }
    log(`${name}: importing...`);
    db.prepare(
      `INSERT INTO import_runs (snapshot, started_at, status) VALUES (?, ?, 'running')
       ON CONFLICT(snapshot) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, status = 'running', stats_json = NULL`
    ).run(name, Math.floor(Date.now() / 1000));
    try {
      const stats = importSnapshot(cfg.backupRoot, name);
      db.prepare("UPDATE import_runs SET status = 'done', finished_at = ?, stats_json = ? WHERE snapshot = ?")
        .run(Math.floor(Date.now() / 1000), JSON.stringify(stats), name);
      allStats.push(stats);
      log(
        `${name}: done in ${stats.seconds}s. ${stats.messages_read} read, ${stats.new_messages} new, ` +
        `${stats.no_stanza_id} without stanza id, media ${stats.media_on_disk}/${stats.media_refs} found.`
      );
    } catch (e) {
      db.prepare("UPDATE import_runs SET status = 'failed', finished_at = ?, stats_json = ? WHERE snapshot = ?")
        .run(Math.floor(Date.now() / 1000), JSON.stringify({ error: e.message }), name);
      log(`${name}: FAILED - ${e.message}`);
      allStats.push({ snapshot: name, error: e.message });
    }
  }

  // Everything with a backup snapshot comes from an iOS backup (this importer only reads iOS).
  db.exec("UPDATE messages SET backup_kind = 'ios' WHERE backup_kind IS NULL AND first_snapshot IS NOT NULL");
  db.exec('UPDATE chats SET last_message_ts = (SELECT MAX(ts) FROM messages WHERE messages.chat_id = chats.chat_id)');

  const report = buildReport(allStats, cfg.probeStanzaIds);
  writeReport(report);
  log(
    `Report written to ${cfg.reportPath}: ${report.totals.messages} messages, ` +
    `${report.totals.oldest_utc} to ${report.totals.newest_utc}.`
  );
  for (const p of report.probes) {
    log(`Probe ${p.stanza_id}: ${p.found ? `FOUND in ${p.matches.map((m) => m.chat_id).join(', ')}` : 'not found'}`);
  }
  return report;
}

module.exports = { runImport, buildReport, discoverSnapshots, normJid };

if (require.main === module) {
  // Tell the server the work is finished BEFORE exiting, so it never has to wait
  // for the process to shut down (closing a large SQLite file can take a while).
  const finish = (code) => {
    if (process.send) {
      try { process.send({ done: true, code }, () => process.exit(code)); } catch (_) { process.exit(code); }
      setTimeout(() => process.exit(code), 5000).unref();
    } else {
      process.exit(code);
    }
  };
  try {
    runImport();
    finish(0);
  } catch (e) {
    console.error(`[import] FAILED: ${e.stack || e.message}`);
    finish(1);
  }
}
