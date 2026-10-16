// The archive database (SQLite). One table of messages for every source:
// the key is "<chat_id>|<STANZA ID>", which is exactly what WAHA's message
// ids contain, so backup rows and WAHA rows land on the same row.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });

const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
// The backup importer runs in a second process; wait for its transaction
// instead of failing.
db.pragma('busy_timeout = 60000');

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  chat_id         TEXT PRIMARY KEY,   -- normalised JID: ...@c.us, ...@lid, ...@g.us
  kind            TEXT NOT NULL,      -- private | group | broadcast
  name            TEXT,
  last_message_ts INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  msg_key        TEXT PRIMARY KEY,    -- "<chat_id>|<STANZA>" or "<chat_id>|bk:<hash>" when no stanza id
  chat_id        TEXT NOT NULL,
  stanza_id      TEXT,                -- upper-case WhatsApp message id, NULL when synthetic
  id_source      TEXT NOT NULL,       -- stanza | synthetic
  from_me        INTEGER NOT NULL,
  sender_jid     TEXT,
  sender_name    TEXT,
  ts             INTEGER NOT NULL,    -- unix seconds (UTC)
  type           TEXT NOT NULL,
  raw_type       INTEGER,
  text           TEXT,
  starred        INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL,       -- backup | waha (which source created the row)
  first_snapshot TEXT,
  media_snapshot TEXT,                -- backup snapshot folder that holds the media file
  media_rel_path TEXT,
  media_file_id  TEXT,                -- fileID inside that snapshot (<snapshot>/<first 2 chars>/<fileID>)
  media_title    TEXT,
  media_size     INTEGER,
  media_on_disk  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_stanza  ON messages (stanza_id);

CREATE TABLE IF NOT EXISTS import_runs (
  snapshot    TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,          -- running | done | failed
  stats_json  TEXT
);

-- Stage 2 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lid_map (    -- WAHA's LID -> phone number JID
  lid TEXT PRIMARY KEY,
  pn  TEXT
);

CREATE TABLE IF NOT EXISTS chat_sync (  -- per chat: how far the WAHA pull has got
  chat_id      TEXT PRIMARY KEY,
  high_ts      INTEGER,               -- newest message timestamp seen from WAHA
  last_full_at INTEGER,
  last_run_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,          -- running | done | failed
  stats_json  TEXT
);

-- Webhook events the archiver does not process yet (edits, revokes, reactions...).
-- Kept so their real shape can be inspected before support is built.
CREATE TABLE IF NOT EXISTS webhook_unhandled (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  event       TEXT,
  body        TEXT
);
`);

function addColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

// Stage 2 columns on messages (added in place so stage-1 data is kept).
addColumn('messages', 'in_waha', 'INTEGER NOT NULL DEFAULT 0');       // WAHA has also reported this message
addColumn('messages', 'waha_id', 'TEXT');                             // WAHA's full id, e.g. false_<chat>_<STANZA>
addColumn('messages', 'waha_media_url', 'TEXT');
addColumn('messages', 'waha_media_path', 'TEXT');                     // local copy, relative to MEDIA_DIR
addColumn('messages', 'waha_media_mime', 'TEXT');
addColumn('messages', 'waha_media_state', 'TEXT');                    // pending | done | failed | skip
addColumn('messages', 'waha_media_attempts', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_media_state ON messages (waha_media_state)');

// Stage 3: which kind of backup a message came from (ios | android). NULL = WAHA only.
// The reader's "reader mode" preference filters on this. Every message that has a backup
// snapshot so far came from an iOS backup, so older rows are tagged 'ios' here.
addColumn('messages', 'backup_kind', 'TEXT');
db.exec("UPDATE messages SET backup_kind = 'ios' WHERE backup_kind IS NULL AND first_snapshot IS NOT NULL");

// Stage 4: reactions, edits, deletions, profile photos and message search.
// Reactions/edits/deletions are keyed by the WhatsApp message id (stanza), not by msg_key, so they
// attach correctly even when the event is stored before the message itself or the chat is merged.
addColumn('messages', 'edited_at', 'INTEGER');   // unix seconds of the newest edit (text = newest text)
db.exec(`
CREATE TABLE IF NOT EXISTS message_reactions (
  stanza_id TEXT NOT NULL,
  reactor   TEXT NOT NULL,             -- 'me' or the reacting person's JID
  emoji     TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (stanza_id, reactor)
);
CREATE TABLE IF NOT EXISTS message_edits (   -- every version of an edited message, original included
  stanza_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  text      TEXT,
  PRIMARY KEY (stanza_id, ts)
);
CREATE TABLE IF NOT EXISTS message_revokes ( -- messages the sender deleted (the archive keeps the content)
  stanza_id TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS avatars (
  jid        TEXT PRIMARY KEY,
  file       TEXT,                     -- relative to MEDIA_DIR/avatars
  status     TEXT NOT NULL,            -- ok | none (no picture or hidden by privacy)
  checked_at INTEGER NOT NULL
);
`);

// Full-text index over the message text (SQLite FTS5, external content: no second copy of the text).
const hadFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get();
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, media_title, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, media_title) VALUES (new.rowid, new.text, new.media_title);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, media_title) VALUES ('delete', old.rowid, old.text, old.media_title);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text, media_title ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, media_title) VALUES ('delete', old.rowid, old.text, old.media_title);
  INSERT INTO messages_fts(rowid, text, media_title) VALUES (new.rowid, new.text, new.media_title);
END;
`);
if (!hadFts) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')"); // first start: index what is already stored

module.exports = { db };
