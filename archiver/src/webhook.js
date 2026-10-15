// Receives WAHA webhooks. New messages (message / message.any) are archived at
// once; every other event is kept raw in webhook_unhandled so its real shape can
// be inspected before support for it is built.
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const { db } = require('./db');
const { toRow, kindOf, mediaCutoff, ingestMessages } = require('./ingest');
const { fetchAndStore } = require('./mediaStore');

const router = express.Router();

const HANDLED = new Set(['message', 'message.any']);
const KEEP_UNHANDLED = 300;
const MAX_BODY_STORED = 100000;

function validSignature(req) {
  if (!cfg.hmacSecret) return true;
  const sig = req.get('x-webhook-hmac');
  if (!sig) return false;
  const expected = crypto.createHmac('sha512', cfg.hmacSecret).update(req.body).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let cutoffCache = { at: 0, value: 0 };
function cachedCutoff() {
  if (Date.now() - cutoffCache.at > 10 * 60 * 1000) cutoffCache = { at: Date.now(), value: mediaCutoff() };
  return cutoffCache.value;
}

const keepUnhandled = db.prepare('INSERT INTO webhook_unhandled (received_at, event, body) VALUES (?, ?, ?)');
const trimUnhandled = db.prepare(
  'DELETE FROM webhook_unhandled WHERE id <= (SELECT MAX(id) FROM webhook_unhandled) - ?'
);
const mediaRow = db.prepare(
  "SELECT msg_key, waha_id, waha_media_url, waha_media_mime FROM messages WHERE msg_key = ? AND waha_media_state = 'pending'"
);

router.post('/webhook', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  if (!validSignature(req)) {
    console.warn('[webhook] signature check failed, request rejected');
    return res.sendStatus(401);
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return res.sendStatus(400);
  }

  if (body.session && body.session !== cfg.wahaSession) return res.sendStatus(200);

  const event = body.event;
  try {
    if (HANDLED.has(event)) {
      const payload = body.payload;
      const chatHint = null; // the chat is part of the WAHA message id
      const row = toRow(payload, chatHint, cachedCutoff(), true);
      if (row) {
        ingestMessages([payload], chatHint, cachedCutoff(), true);
        // WAHA already downloaded live media: store our own copy now. A failure is retried by the next sync.
        const pending = row.media_state === 'pending' ? mediaRow.get(row.msg_key) : null;
        if (pending) fetchAndStore(pending).catch(() => {});
      }
    } else {
      keepUnhandled.run(Math.floor(Date.now() / 1000), event || null, req.body.toString('utf8').slice(0, MAX_BODY_STORED));
      trimUnhandled.run(KEEP_UNHANDLED);
    }
  } catch (e) {
    console.error(`[webhook] ${event} failed: ${e.message}`);
    return res.sendStatus(500); // WAHA retries
  }
  return res.sendStatus(200);
});

module.exports = { router, kindOf };
