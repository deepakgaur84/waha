// Stage 2: pull what WAHA holds (chats, messages, LID map) into the archive.
//
// First run: every chat is read from the beginning. Later runs only ask for
// messages newer than what was seen last time (with a safety overlap), and
// duplicates are harmless because rows are keyed on the WhatsApp message id.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { db } = require('./db');
const wahaClient = require('./wahaClient');
const { canonicalJid, kindOf, mediaCutoff, ingestMessages, mergeLidChats, reloadLidCache } = require('./ingest');
const { processPendingMedia } = require('./mediaStore');
const prefsStore = require('./prefs');

const MAX_PAGES_PER_CHAT = 5000;

const state = { running: false, last_started: null, last_finished: null, last_status: null, last_error: null, last_stats: null };

function log(msg) {
  console.log(`[sync ${new Date().toISOString()}] ${msg}`);
}

const upsertChatMeta = db.prepare(`
  INSERT INTO chats (chat_id, kind, name) VALUES (@chat_id, @kind, @name)
  ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(chats.name, excluded.name)
`);
const getChatSync = db.prepare('SELECT high_ts FROM chat_sync WHERE chat_id = ?');
const saveChatSync = db.prepare(`
  INSERT INTO chat_sync (chat_id, high_ts, last_full_at, last_run_at) VALUES (@chat_id, @high_ts, @full_at, @now)
  ON CONFLICT(chat_id) DO UPDATE SET
    high_ts = MAX(COALESCE(chat_sync.high_ts, 0), COALESCE(excluded.high_ts, 0)),
    last_full_at = COALESCE(excluded.last_full_at, chat_sync.last_full_at),
    last_run_at = excluded.last_run_at
`);

async function syncLids(stats) {
  const limit = 500;
  let offset = 0;
  let total = 0;
  let firstOfPrev = null;
  const save = db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn');
  const saveAll = db.transaction((rows) => {
    for (const r of rows) if (r && r.lid) save.run(r.lid, r.pn || null);
  });
  for (let page = 0; page < 1000; page += 1) {
    const rows = await wahaClient.getLids(limit, offset);
    if (!Array.isArray(rows) || rows.length === 0) break;
    if (rows[0] && rows[0].lid === firstOfPrev) break; // server ignored offset: stop instead of looping
    firstOfPrev = rows[0] && rows[0].lid;
    saveAll(rows);
    total += rows.length;
    offset += limit;
  }
  reloadLidCache();
  stats.lids = total;
}

async function listChats() {
  const limit = cfg.pageSize;
  const out = [];
  let offset = 0;
  let firstOfPrev = null;
  for (let page = 0; page < 1000; page += 1) {
    const rows = await wahaClient.getChats(limit, offset);
    if (!Array.isArray(rows) || rows.length === 0) break;
    const firstId = wahaClient.idOf(rows[0] && rows[0].id);
    if (firstId && firstId === firstOfPrev) break;
    firstOfPrev = firstId;
    out.push(...rows);
    offset += limit;
  }
  return out;
}

async function syncChat(rawChat, cutoff, stats, opts) {
  const rawId = wahaClient.idOf(rawChat.id);
  if (!rawId) return;
  if (opts.skipSuffixes.some((s) => rawId.endsWith(s))) { stats.chats_skipped += 1; return; }

  const chatId = canonicalJid(rawId);
  upsertChatMeta.run({ chat_id: chatId, kind: kindOf(chatId), name: rawChat.name || null });

  const prev = opts.full ? null : getChatSync.get(chatId);
  const gte = prev && prev.high_ts ? prev.high_ts - cfg.overlapSeconds : null;

  let offset = 0;
  let maxTs = 0;
  let firstOfPrev = null;
  for (let page = 0; page < MAX_PAGES_PER_CHAT; page += 1) {
    const messages = await wahaClient.getMessages(rawId, { limit: cfg.pageSize, offset, gte });
    // WAHA documents that a short page does not mean the end: only an empty page does.
    if (!Array.isArray(messages) || messages.length === 0) break;
    if (messages[0] && messages[0].id === firstOfPrev) { log(`${rawId}: server repeated a page, stopping`); break; }
    firstOfPrev = messages[0] && messages[0].id;

    const r = ingestMessages(messages, rawId, cutoff, false);
    stats.messages_seen += r.seen;
    if (r.maxTs > maxTs) maxTs = r.maxTs;
    offset += cfg.pageSize;
  }

  saveChatSync.run({
    chat_id: chatId,
    high_ts: maxTs || null,
    full_at: gte ? null : Math.floor(Date.now() / 1000),
    now: Math.floor(Date.now() / 1000),
  });
  stats.chats_synced += 1;
}

// options.full = ignore saved per-chat progress and read every chat's whole history again.
async function runSync(options = {}) {
  if (state.running) return false;
  const opts = {
    full: Boolean(options.full) || cfg.fullResync,
    skipSuffixes: prefsStore.get().skip_chat_suffixes, // read fresh: changed in the reader
  };
  state.running = true;
  state.last_started = new Date().toISOString();
  state.last_error = null;

  const stats = {
    lids: 0, chats_seen: 0, chats_synced: 0, chats_skipped: 0, chat_errors: 0,
    messages_seen: 0, new_messages: 0, lid_merge: null, media: null, errors: [],
  };
  const startedAt = Math.floor(Date.now() / 1000);
  const runId = db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(startedAt).lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

  try {
    const session = await wahaClient.getSession();
    if (!session || session.status !== 'WORKING') {
      throw new Error(`WAHA session "${cfg.wahaSession}" is ${session ? session.status : 'unknown'}, not WORKING`);
    }
    log(`WAHA session is WORKING; ${opts.full ? 'FULL resync' : 'sync (new messages since last run)'}`);

    await syncLids(stats);
    log(`${stats.lids} LID mappings loaded`);
    stats.lid_merge = mergeLidChats();

    const cutoff = mediaCutoff();
    const chats = await listChats();
    stats.chats_seen = chats.length;
    log(`${chats.length} chats to read; media is fetched for messages newer than ${new Date(cutoff * 1000).toISOString()}`);

    let i = 0;
    for (const chat of chats) {
      i += 1;
      try {
        await syncChat(chat, cutoff, stats, opts);
      } catch (e) {
        stats.chat_errors += 1;
        if (stats.errors.length < 20) stats.errors.push(`${wahaClient.idOf(chat.id)}: ${e.message}`);
        log(`chat ${wahaClient.idOf(chat.id)} failed: ${e.message}`);
      }
      if (i % 25 === 0) log(`${i}/${chats.length} chats done, ${stats.messages_seen} messages read`);
    }

    const merge2 = mergeLidChats(); // chats that appeared during this run
    stats.lid_merge.chats_merged += merge2.chats_merged;
    stats.lid_merge.duplicates_dropped += merge2.duplicates_dropped;

    db.exec('UPDATE chats SET last_message_ts = (SELECT MAX(ts) FROM messages WHERE messages.chat_id = chats.chat_id)');

    stats.media = await processPendingMedia();
    stats.new_messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n - before;

    db.prepare("UPDATE sync_runs SET status = 'done', finished_at = ?, stats_json = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), JSON.stringify(stats), runId);
    state.last_status = 'done';
    log(
      `done: ${stats.chats_synced} chats, ${stats.messages_seen} messages read, ${stats.new_messages} new; ` +
      `media ${stats.media.downloaded}/${stats.media.attempted} downloaded, ${stats.media.pending_left} still pending; ` +
      `${stats.chat_errors} chat errors`
    );
  } catch (e) {
    state.last_status = 'failed';
    state.last_error = e.message;
    stats.errors.push(e.message);
    db.prepare("UPDATE sync_runs SET status = 'failed', finished_at = ?, stats_json = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), JSON.stringify(stats), runId);
    log(`FAILED: ${e.message}`);
  } finally {
    state.running = false;
    state.last_finished = new Date().toISOString();
    state.last_stats = stats;
    try {
      // Readable from File Station: the result of the latest sync run.
      fs.writeFileSync(
        path.join(cfg.dataDir, 'sync-report.json'),
        JSON.stringify({ status: state.last_status, finished_at: state.last_finished, error: state.last_error, ...stats }, null, 2)
      );
    } catch (_) { /* reporting must never break a sync */ }
  }
  return state.last_status === 'done';
}

module.exports = { runSync, syncState: state };
