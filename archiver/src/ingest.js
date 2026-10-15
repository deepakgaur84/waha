// Turns WAHA messages (from the REST API or from webhooks) into archive rows,
// and keeps WAHA's "@lid" identities consistent with the backup's phone-number JIDs.
const { db } = require('./db');
const cfg = require('./config');

// ------------------------------------------------------------- LID handling

let lidCache = new Map();

function reloadLidCache() {
  lidCache = new Map(
    db.prepare('SELECT lid, pn FROM lid_map WHERE pn IS NOT NULL').all().map((r) => [r.lid, r.pn])
  );
}
reloadLidCache();

// One identity per person: iOS "@s.whatsapp.net" becomes WAHA's "@c.us", and an
// "@lid" becomes the phone-number JID whenever WAHA knows the mapping.
function canonicalJid(jid) {
  if (!jid) return null;
  let j = String(jid).trim().replace(/:\d+@/, '@').replace(/@s\.whatsapp\.net$/, '@c.us');
  if (j.endsWith('@lid')) j = lidCache.get(j) || j;
  return j;
}

function kindOf(chatId) {
  if (chatId.endsWith('@g.us')) return 'group';
  if (chatId.endsWith('@broadcast') || chatId.endsWith('@newsletter')) return 'broadcast';
  return 'private';
}

// ----------------------------------------------------------- id and type logic

// WAHA ids look like "true_<chatId>_<STANZA>"; group messages add "_<participant>".
function parseWahaId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split('_');
  if (parts.length < 3 || !parts[2]) return null;
  return { fromMe: parts[0] === 'true', chat: parts[1], stanza: parts[2], participant: parts[3] || null };
}

const MESSAGE_KEYS = {
  imageMessage: 'image', videoMessage: 'video', ptvMessage: 'video', audioMessage: 'audio',
  documentMessage: 'document', documentWithCaptionMessage: 'document', stickerMessage: 'sticker',
  locationMessage: 'location', liveLocationMessage: 'location', contactMessage: 'contact',
  contactsArrayMessage: 'contact', pollCreationMessage: 'poll', reactionMessage: 'reaction',
  protocolMessage: 'system', conversation: 'text', extendedTextMessage: 'text',
};

// Same labels the backup importer uses (text, image, video, audio, document, sticker...).
function typeOf(p) {
  const m = p && p._data && p._data.Message;
  if (m && typeof m === 'object') {
    for (const k of Object.keys(m)) if (MESSAGE_KEYS[k]) return MESSAGE_KEYS[k];
  }
  const mime = p && p.media && p.media.mimetype;
  if (mime) {
    const t = String(mime).split('/')[0];
    return ['image', 'video', 'audio'].includes(t) ? t : 'document';
  }
  return p && p.body ? 'text' : 'other';
}

// Newest backup message minus a day: anything newer has no backup copy of its media.
function mediaCutoff() {
  const row = db.prepare("SELECT MAX(ts) AS t FROM messages WHERE source = 'backup'").get();
  if (row && row.t) return row.t - 86400;
  return Math.floor(Date.now() / 1000) - cfg.mediaDefaultDays * 86400;
}

// payload: one WAHA message. chatHint: the chat it was fetched from (API) or
// null (webhook, where the chat is part of the id). fromWebhook: WAHA has
// already downloaded the media, so media.url can be trusted.
function toRow(p, chatHint, cutoff, fromWebhook) {
  if (!p || !p.id) return null;
  const parsed = parseWahaId(p.id);
  if (!parsed) return null;

  const chatId = canonicalJid(chatHint || parsed.chat);
  if (!chatId) return null;

  const fromMe = typeof p.fromMe === 'boolean' ? p.fromMe : parsed.fromMe;
  let ts = Number(p.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (ts > 1e11) ts = Math.floor(ts / 1000); // milliseconds -> seconds

  const info = (p._data && p._data.Info) || {};
  let senderJid = null;
  if (!fromMe) {
    senderJid = chatId.endsWith('@g.us')
      ? canonicalJid(p.participant || parsed.participant || info.Sender)
      : chatId;
  }

  const hasMedia = !!p.hasMedia;
  return {
    msg_key: `${chatId}|${parsed.stanza.toUpperCase()}`,
    chat_id: chatId,
    stanza_id: parsed.stanza.toUpperCase(),
    from_me: fromMe ? 1 : 0,
    sender_jid: senderJid,
    sender_name: fromMe ? null : (info.PushName || p.notifyName || null) || null,
    ts,
    type: typeOf(p),
    text: typeof p.body === 'string' && p.body !== '' ? p.body : null,
    waha_id: p.id,
    media_url: hasMedia && fromWebhook && p.media && p.media.url ? p.media.url : null,
    media_mime: hasMedia && p.media && p.media.mimetype ? p.media.mimetype : null,
    media_state: hasMedia ? (ts > cutoff ? 'pending' : 'skip') : null,
  };
}

// ------------------------------------------------------------------- writing

const ensureChat = db.prepare('INSERT OR IGNORE INTO chats (chat_id, kind, name) VALUES (?, ?, NULL)');

const upsertWahaMessage = db.prepare(`
  INSERT INTO messages
    (msg_key, chat_id, stanza_id, id_source, from_me, sender_jid, sender_name, ts, type, raw_type,
     text, starred, source, first_snapshot, in_waha, waha_id, waha_media_url, waha_media_mime, waha_media_state)
  VALUES
    (@msg_key, @chat_id, @stanza_id, 'stanza', @from_me, @sender_jid, @sender_name, @ts, @type, NULL,
     @text, 0, 'waha', NULL, 1, @waha_id, @media_url, @media_mime, @media_state)
  ON CONFLICT(msg_key) DO UPDATE SET
    in_waha          = 1,
    waha_id          = COALESCE(messages.waha_id, excluded.waha_id),
    text             = COALESCE(messages.text, excluded.text),
    sender_name      = COALESCE(messages.sender_name, excluded.sender_name),
    sender_jid       = COALESCE(messages.sender_jid, excluded.sender_jid),
    waha_media_url   = COALESCE(excluded.waha_media_url, messages.waha_media_url),
    waha_media_mime  = COALESCE(excluded.waha_media_mime, messages.waha_media_mime),
    waha_media_state = CASE
      WHEN messages.waha_media_state IS NOT NULL THEN messages.waha_media_state
      WHEN messages.media_on_disk = 1 THEN 'skip'
      ELSE excluded.waha_media_state
    END
`);

// Stores a batch of WAHA messages in one transaction. Returns how many were
// usable and the newest timestamp among them.
const ingestMessages = db.transaction((messages, chatHint, cutoff, fromWebhook) => {
  let seen = 0;
  let maxTs = 0;
  for (const p of messages) {
    const row = toRow(p, chatHint, cutoff, fromWebhook);
    if (!row) continue;
    ensureChat.run(row.chat_id, kindOf(row.chat_id));
    upsertWahaMessage.run(row);
    seen += 1;
    if (row.ts > maxTs) maxTs = row.ts;
  }
  return { seen, maxTs };
});

// ----------------------------------------------------------- LID chat merging

// Chats the backup stored under an "@lid" are folded into the phone-number chat
// once WAHA tells us which number the LID belongs to. Rows that exist under both
// ids are the same message, so the "@lid" copy is dropped.
const mergeLidChats = db.transaction(() => {
  const stats = { chats_merged: 0, duplicates_dropped: 0, senders_updated: 0 };
  const pairs = db
    .prepare('SELECT l.lid AS lid, l.pn AS pn FROM lid_map l JOIN chats c ON c.chat_id = l.lid WHERE l.pn IS NOT NULL')
    .all();

  for (const { lid, pn } of pairs) {
    db.prepare(
      'UPDATE OR IGNORE messages SET chat_id = ?, msg_key = ? || substr(msg_key, ?) WHERE chat_id = ?'
    ).run(pn, pn, lid.length + 1, lid);
    stats.duplicates_dropped += db.prepare('DELETE FROM messages WHERE chat_id = ?').run(lid).changes;

    db.prepare(
      `INSERT INTO chats (chat_id, kind, name)
       SELECT ?, kind, name FROM chats WHERE chat_id = ?
       ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(chats.name, excluded.name)`
    ).run(pn, lid);
    db.prepare('DELETE FROM chats WHERE chat_id = ?').run(lid);

    db.prepare('UPDATE OR IGNORE chat_sync SET chat_id = ? WHERE chat_id = ?').run(pn, lid);
    db.prepare('DELETE FROM chat_sync WHERE chat_id = ?').run(lid);
    stats.chats_merged += 1;
  }

  // Senders inside groups may also be stored as "@lid".
  stats.senders_updated = db
    .prepare(
      `UPDATE messages SET sender_jid = (SELECT pn FROM lid_map WHERE lid = messages.sender_jid)
       WHERE sender_jid LIKE '%@lid'
         AND sender_jid IN (SELECT lid FROM lid_map WHERE pn IS NOT NULL)`
    )
    .run().changes;

  return stats;
});

module.exports = {
  canonicalJid, kindOf, parseWahaId, toRow, mediaCutoff, ingestMessages, mergeLidChats, reloadLidCache, ensureChat,
};
