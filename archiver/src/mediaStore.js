// Downloads media for messages only WAHA has (newer than the newest backup)
// and stores each file once, named by its content hash, under MEDIA_DIR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { db } = require('./db');
const wahaClient = require('./wahaClient');
const { parseWahaId } = require('./ingest');

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

function extFor(mime, url) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const fromUrl = path.extname(new URL(url, 'http://x').pathname).replace('.', '');
  return fromUrl && fromUrl.length <= 5 ? fromUrl.toLowerCase() : 'bin';
}

function saveBuffer(buffer, mime, url) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const rel = path.join(hash.slice(0, 2), `${hash}.${extFor(mime, url)}`);
  const abs = path.join(cfg.mediaDir, rel);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.part`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, abs);
  }
  return { rel: rel.split(path.sep).join('/'), size: buffer.length };
}

const markDone = db.prepare(`
  UPDATE messages SET waha_media_state = 'done', waha_media_path = ?, waha_media_mime = ?,
         media_size = COALESCE(media_size, ?), waha_media_url = NULL
  WHERE msg_key = ?`);
const markRetry = db.prepare(`
  UPDATE messages SET waha_media_attempts = waha_media_attempts + 1,
         waha_media_state = CASE WHEN waha_media_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
         waha_media_url = NULL
  WHERE msg_key = ?`);

// WhatsApp no longer has the file (403 / 404 / 410 from its servers). Trying again cannot help.
const EXPIRED_RE = /status code (403|404|410)\b/;
const markExpired = db.prepare(
  "UPDATE messages SET waha_media_attempts = ?, waha_media_state = 'failed', waha_media_url = NULL WHERE msg_key = ?"
);

// row: { msg_key, waha_id, waha_media_url, waha_media_mime }
// Returns 'ok', 'expired' (permanent: marked failed at once) or 'error' (may be temporary: retried later).
async function attempt(row) {
  try {
    let url = row.waha_media_url;
    let mime = row.waha_media_mime;
    if (!url) {
      const parsed = parseWahaId(row.waha_id);
      if (!parsed) throw new Error('unusable WAHA id');
      // Asks WAHA to download the file (and the phone to re-upload it if WhatsApp dropped it).
      const msg = await wahaClient.getMessageWithMedia(parsed.chat, row.waha_id);
      const media = msg && msg.media;
      url = media && media.url;
      mime = (media && media.mimetype) || mime;
      if (!url) throw new Error(`WAHA gave no media url${media && media.error ? ` (${JSON.stringify(media.error)})` : ''}`);
    }
    const { buffer, contentType } = await wahaClient.downloadFile(url);
    if (!buffer.length) throw new Error('empty file');
    const saved = saveBuffer(buffer, mime || contentType, url);
    markDone.run(saved.rel, mime || contentType || null, saved.size, row.msg_key);
    return 'ok';
  } catch (e) {
    if (EXPIRED_RE.test(e.message)) {
      markExpired.run(cfg.mediaMaxAttempts, row.msg_key);
      // One short line: the full gRPC stack trace adds nothing for an expired file.
      console.warn(`[media] ${row.msg_key}: expired on WhatsApp's servers, marked as failed`);
      return 'expired';
    }
    markRetry.run(cfg.mediaMaxAttempts, row.msg_key);
    console.warn(`[media] ${row.msg_key}: ${e.message.slice(0, 300)}`);
    return 'error';
  }
}

async function fetchAndStore(row) {
  return (await attempt(row)) === 'ok';
}

async function runPool(items, size, fn, shouldStop = () => false) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Processes pending media, newest messages first.
// Keeps going in batches until every pending file has had one attempt in this run:
// files never tried come first, then retries of earlier failures (newest first).
// A file is attempted at most once per run, so expired media cannot loop forever.
async function processPendingMedia() {
  const select = db.prepare(
    `SELECT msg_key, ts, waha_id, waha_media_url, waha_media_mime FROM messages
     WHERE waha_media_state = 'pending' AND waha_media_attempts < ?
     ORDER BY waha_media_attempts ASC, ts DESC LIMIT ?`
  );
  const tried = new Set();
  let ok = 0;
  let failed = 0;
  let batchNo = 0;
  // Newest files are tried first, so files only get older as the run goes on. When several in a row have
  // expired, everything older has expired too: those are marked failed without waiting for each one.
  let streak = 0;
  let streakNewestTs = 0;
  let tripped = false;
  let skippedOlder = 0;

  for (;;) {
    // Over-fetch so rows already tried in this run can be skipped without ending the loop early.
    const rows = select.all(cfg.mediaMaxAttempts, cfg.mediaBatch + tried.size).filter((r) => !tried.has(r.msg_key)).slice(0, cfg.mediaBatch);
    if (rows.length === 0) break;
    batchNo += 1;
    console.log(`[media] batch ${batchNo}: ${rows.length} file(s); ${tried.size} already attempted in this run`);
    await runPool(rows, cfg.mediaConcurrency, async (row) => {
      tried.add(row.msg_key);
      const result = await attempt(row);
      if (result === 'ok') { ok += 1; streak = 0; }
      else {
        failed += 1;
        if (result === 'expired') {
          if (streak === 0) streakNewestTs = row.ts;
          streak += 1;
          if (streak >= cfg.mediaExpiredStreak) tripped = true;
        } else {
          streak = 0;
        }
      }
      if (tried.size % 50 === 0) console.log(`[media] progress: ${tried.size} attempted, ${ok} downloaded, ${failed} failed`);
    }, () => tripped);
    if (tripped) {
      skippedOlder = db
        .prepare("UPDATE messages SET waha_media_state = 'failed', waha_media_attempts = ? WHERE waha_media_state = 'pending' AND ts <= ?")
        .run(cfg.mediaMaxAttempts, streakNewestTs).changes;
      console.log(
        `[media] ${cfg.mediaExpiredStreak} files in a row had expired on WhatsApp's servers, so older ones are assumed gone too: ` +
        `${skippedOlder} older file(s) marked as failed without trying. "Retry failed media" in Preferences tries them again.`
      );
      break;
    }
  }

  const left = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE waha_media_state = 'pending'").get().n;
  return { attempted: tried.size, downloaded: ok, failed_this_run: failed, assumed_expired: skippedOlder, pending_left: left };
}

module.exports = { processPendingMedia, fetchAndStore, saveBuffer };
