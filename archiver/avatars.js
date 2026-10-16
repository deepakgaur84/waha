// Profile photos. WAHA gives a short-lived WhatsApp URL per chat; the picture is downloaded once and
// kept on disk. Runs slowly in the background after a sync so it never competes with real work.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { db } = require('./db');
const prefsStore = require('./prefs');
const wahaClient = require('./wahaClient');

const DIR = path.join(cfg.mediaDir, 'avatars');
const OK_DAYS = 30;     // look again for a changed photo after this long
const NONE_DAYS = 7;    // look again for a photo that was missing or hidden
const PAUSE_MS = 1000;  // between WAHA requests
const MAX_PER_RUN = 400;

// Called after every run (the server uses it to refresh the reader's chat list).
let afterRun = () => {};
function setAfterRun(fn) { afterRun = fn; }

const state = { running: false, done: 0, total: 0, last_finished: null, last_stats: null, last_errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileFor = (jid) => `${crypto.createHash('sha1').update(jid).digest('hex')}.jpg`;

const mark = db.prepare(`
  INSERT INTO avatars (jid, file, status, checked_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET file = excluded.file, status = excluded.status, checked_at = excluded.checked_at`);

function dueChats(suffixes) {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(`SELECT m.chat_id AS chat_id, MAX(m.ts) AS last_ts, a.status AS status, a.checked_at AS checked_at
              FROM messages m LEFT JOIN avatars a ON a.jid = m.chat_id GROUP BY m.chat_id ORDER BY last_ts DESC`)
    .all();
  const lower = suffixes.map((x) => x.toLowerCase());
  return rows
    .filter((r) => !lower.some((x) => r.chat_id.toLowerCase().endsWith(x)))
    .filter((r) => {
      if (!r.status) return true;
      const age = now - r.checked_at;
      return r.status === 'ok' ? age > OK_DAYS * 86400 : age > NONE_DAYS * 86400;
    })
    .map((r) => r.chat_id);
}

async function download(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('picture URL is not https');
  const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`picture download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 5 * 1024 * 1024) throw new Error('picture has an unexpected size');
  return buf;
}

// Returns stats, or null when it did not run.
async function syncAvatars() {
  const prefs = prefsStore.get();
  if (!prefs.fetch_avatars || state.running) return null;
  state.running = true;
  const stats = { checked: 0, saved: 0, none: 0, errors: 0 };
  state.last_errors = [];
  state.done = 0;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const due = dueChats(prefs.skip_chat_suffixes || []).slice(0, MAX_PER_RUN);
    state.total = due.length;
    console.log(`[avatars] ${due.length} chat(s) to check for a profile photo`);
    let consecutiveErrors = 0;
    for (const jid of due) {
      if (!prefsStore.get().fetch_avatars) break;
      const now = Math.floor(Date.now() / 1000);
      try {
        const r = await wahaClient.getChatPicture(jid);
        const url = r && (r.url || r.profilePictureURL);
        stats.checked += 1;
        if (!url) {
          mark.run(jid, null, 'none', now);
          stats.none += 1;
        } else {
          const buf = await download(url);
          const file = fileFor(jid);
          fs.writeFileSync(path.join(DIR, `${file}.part`), buf);
          fs.renameSync(path.join(DIR, `${file}.part`), path.join(DIR, file));
          mark.run(jid, file, 'ok', now);
          stats.saved += 1;
        }
        consecutiveErrors = 0;
      } catch (e) {
        stats.errors += 1;
        consecutiveErrors += 1;
        // The reason matters when no photos appear, so the first few are logged and shown in Preferences.
        if (state.last_errors.length < 5) {
          const why = `${jid.split('@')[0].slice(-4).padStart(jid.split('@')[0].length, '*')}: ${e.message}`;
          state.last_errors.push(why);
          console.warn(`[avatars] ${why}`);
        }
        // A 4xx from WAHA means "no picture for this chat"; anything else may be temporary and is retried next time.
        if (e.status && e.status >= 400 && e.status < 500) {
          mark.run(jid, null, 'none', now);
          consecutiveErrors = 0;
        }
        if (consecutiveErrors >= 5) {
          console.warn(`[avatars] stopping early after repeated errors (${e.message})`);
          break;
        }
      }
      state.done += 1;
      await sleep(PAUSE_MS);
    }
    console.log(`[avatars] finished: ${stats.checked} checked, ${stats.saved} saved, ${stats.none} without a picture, ${stats.errors} error(s)`);
  } finally {
    state.running = false;
    state.last_finished = new Date().toISOString();
    state.last_stats = stats;
    try { afterRun(); } catch (_) { /* never let a UI refresh break the job */ }
  }
  return stats;
}

function avatarPath(jid) {
  const row = db.prepare("SELECT file FROM avatars WHERE jid = ? AND status = 'ok'").get(jid);
  if (!row || !row.file) return null;
  const abs = path.join(DIR, row.file);
  return abs.startsWith(DIR + path.sep) && fs.existsSync(abs) ? abs : null;
}

module.exports = { syncAvatars, avatarPath, setAfterRun, avatarState: state };
