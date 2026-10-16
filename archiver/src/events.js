// Applies WAHA's message.reaction, message.edited and message.revoked events.
// Payload shapes (from WAHA's source, GOWS engine):
//   reaction: { from, fromMe, participant, timestamp, reaction: { text, messageId: "false_<chat>_<STANZA>" } }   text "" = removed
//   edited:   { ...message, body: <new text>, editedMessageId: "<STANZA>", timestamp }
//   revoked:  { revokedMessageId: "<STANZA>", after: <the revoke message> }
const { db } = require('./db');
const { parseWahaId, canonicalJid } = require('./ingest');

function seconds(v) {
  let t = Number(v);
  if (!Number.isFinite(t) || t <= 0) return Math.floor(Date.now() / 1000);
  if (t > 1e11) t = Math.floor(t / 1000);
  return t;
}

const setReaction = db.prepare(`
  INSERT INTO message_reactions (stanza_id, reactor, emoji, ts) VALUES (?, ?, ?, ?)
  ON CONFLICT(stanza_id, reactor) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts
  WHERE excluded.ts >= message_reactions.ts`);
const clearReaction = db.prepare('DELETE FROM message_reactions WHERE stanza_id = ? AND reactor = ? AND ts <= ?');

// Returns false when the payload does not have the expected shape.
function applyReaction(p) {
  const r = p && p.reaction;
  const parsed = r && parseWahaId(r.messageId);
  if (!parsed) return false;
  const stanza = parsed.stanza.toUpperCase();
  const reactor = p.fromMe ? 'me' : canonicalJid(p.participant || p.from) || 'unknown';
  const ts = seconds(p.timestamp);
  const emoji = typeof r.text === 'string' ? r.text : '';
  if (emoji === '') clearReaction.run(stanza, reactor, ts);
  else setReaction.run(stanza, reactor, emoji, ts);
  return true;
}

const findByStanza = db.prepare('SELECT ts, text, edited_at FROM messages WHERE stanza_id = ?');
const insertEdit = db.prepare('INSERT OR IGNORE INTO message_edits (stanza_id, ts, text) VALUES (?, ?, ?)');
const updateText = db.prepare(
  'UPDATE messages SET text = ?, edited_at = ? WHERE stanza_id = ? AND (edited_at IS NULL OR edited_at < ?)'
);
const edit = db.transaction((stanza, ts, text) => {
  for (const m of findByStanza.all(stanza)) {
    // First edit of this message: keep the original text as version one.
    if (m.edited_at == null && m.text != null) insertEdit.run(stanza, m.ts, m.text);
  }
  insertEdit.run(stanza, ts, text);
  updateText.run(text, ts, stanza, ts);
});

function applyEdit(p) {
  if (!p || !p.editedMessageId || typeof p.body !== 'string' || p.body === '') return false;
  edit(String(p.editedMessageId).toUpperCase(), seconds(p.timestamp), p.body);
  return true;
}

const insertRevoke = db.prepare('INSERT OR IGNORE INTO message_revokes (stanza_id, ts) VALUES (?, ?)');
function applyRevoke(p) {
  if (!p || !p.revokedMessageId) return false;
  insertRevoke.run(String(p.revokedMessageId).toUpperCase(), seconds(p.after && p.after.timestamp));
  return true;
}

const APPLY = {
  'message.reaction': applyReaction,
  'message.edited': applyEdit,
  'message.revoked': applyRevoke,
};

// Events stored raw by earlier versions (webhook_unhandled) are applied once, then removed.
function replayStored() {
  const rows = db
    .prepare("SELECT id, event, body FROM webhook_unhandled WHERE event IN ('message.reaction','message.edited','message.revoked') ORDER BY id")
    .all();
  const done = { applied: 0, unusable: 0 };
  for (const row of rows) {
    let ok = false;
    try { ok = APPLY[row.event](JSON.parse(row.body).payload); } catch (_) { ok = false; }
    if (ok) {
      done.applied += 1;
      db.prepare('DELETE FROM webhook_unhandled WHERE id = ?').run(row.id);
    } else {
      done.unusable += 1; // left in place so its shape can still be inspected
    }
  }
  return done;
}

module.exports = { APPLY, applyReaction, applyEdit, applyRevoke, replayStored };
