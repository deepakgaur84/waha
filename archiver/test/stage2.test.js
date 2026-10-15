// End-to-end test of stage 2 against the mock WAHA. Run from the test folder:  node stage2.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const BASE = '/tmp/claude-0/-home-claude/c2aa04bd-c895-597b-874d-73980ec4794b/scratchpad';
const APP = `${BASE}/waha-archiver-v2/app`;
const TEST = `${BASE}/waha-archiver-v2-test`;
const FX = `${TEST}/fx3`;
const Database = require(`${APP}/node_modules/better-sqlite3`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(300);
  }
}

const env = {
  ...process.env,
  DATA_DIR: `${FX}/data`, BACKUP_ROOT: `${FX}/backup`,
  WAHA_BASE_URL: 'http://localhost:4010', WAHA_API_KEY: 'secret', WAHA_SESSION: 'default',
  WAHA_WEBHOOK_HMAC_SECRET: 'hmacsecret', WAHA_PAGE_SIZE: '2', WAHA_SYNC_INTERVAL_MINUTES: '0',
  WAHA_MEDIA_MAX_ATTEMPTS: '2', PORT: '4011', BACKUP_IMPORT_ON_START: 'false', WAHA_SYNC_ON_START: 'true',
};

function startServer() {
  const p = spawn('node', [`${APP}/src/server.js`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (p.out = (p.out || '') + d));
  p.stderr.on('data', (d) => (p.out = (p.out || '') + d));
  return p;
}
const status = () => fetch('http://localhost:4011/api/status').then((r) => r.json());
const waitSyncDone = (afterStarted) =>
  until(async () => {
    const s = await status();
    return s.sync.last_finished && s.sync.last_finished !== afterStarted && !s.sync.running ? s : null;
  }, 'sync to finish');
const sign = (buf) => crypto.createHmac('sha512', 'hmacsecret').update(buf).digest('hex');
async function hook(bodyObj, sig) {
  const body = Buffer.from(JSON.stringify(bodyObj));
  const res = await fetch('http://localhost:4011/webhook', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-webhook-hmac': sig === undefined ? sign(body) : sig, 'x-webhook-hmac-algorithm': 'sha512' },
  });
  return res.status;
}
const q = (sql, ...a) => { const d = new Database(`${FX}/data/archive.db`, { readonly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };

(async () => {
  // ---- fixture + stage-1 import (reuse the stage-1 fixture builder)
  execFileSync('node', [`${TEST}/makeFixture.js`, FX], { stdio: 'ignore' });
  execFileSync('node', [`${APP}/src/backupImport.js`], { env, stdio: 'ignore' });
  assert.strictEqual(q('SELECT COUNT(*) n FROM messages')[0].n, 7, 'backup rows imported');

  const mock = spawn('node', [`${TEST}/mockWaha.js`, '4010'], { stdio: 'ignore' });
  await until(() => fetch('http://localhost:4010/__log').then((r) => r.ok), 'mock WAHA');
  let server = startServer();
  const killAll = () => { try { server.kill(); } catch (_) {} try { mock.kill(); } catch (_) {} };
  process.on('exit', killAll);

  try {
    // ================= run 1: first (full) sync =================
    let s = await waitSyncDone(null);
    assert.strictEqual(s.sync.last_status, 'done', 'sync 1 ' + JSON.stringify(s.sync));
    const st = s.sync.last_stats;
    assert.strictEqual(st.chat_errors, 1, 'only the broken chat fails');
    assert.strictEqual(st.chats_skipped, 2, 'status + newsletter skipped');
    assert.strictEqual(st.lids, 2);

    // totals: 7 backup rows + 6 new WAHA-only rows; 5 of WAHA's messages overlap the backup
    assert.strictEqual(q('SELECT COUNT(*) n FROM messages')[0].n, 13, 'row count after sync 1');
    assert.strictEqual(q('SELECT COUNT(*) n FROM messages WHERE in_waha = 1')[0].n, 5 + 6, 'overlap rows flagged + new rows');

    // overlapping message not duplicated, still the backup's row, now flagged
    const hello = q("SELECT * FROM messages WHERE msg_key = '64211111111@c.us|96E48E72D8E53CA026BCBCFA53FBD0DC'")[0];
    assert.strictEqual(hello.source, 'backup'); assert.strictEqual(hello.in_waha, 1); assert.strictEqual(hello.text, 'hello');
    assert.strictEqual(hello.waha_id, 'false_64211111111@c.us_96E48E72D8E53CA026BCBCFA53FBD0DC');

    // @lid chat folded into the phone-number chat, backup name kept
    assert.strictEqual(q("SELECT COUNT(*) n FROM chats WHERE chat_id = '145483494371461@lid'")[0].n, 0, 'lid chat gone');
    const lidChat = q("SELECT * FROM chats WHERE chat_id = '64277777777@c.us'")[0];
    assert.strictEqual(lidChat.name, 'Lid person');
    assert.strictEqual(q("SELECT COUNT(*) n FROM messages WHERE chat_id = '64277777777@c.us'")[0].n, 2, 'lid chat: 1 backup + 1 new');
    assert.strictEqual(q("SELECT COUNT(*) n FROM messages WHERE chat_id LIKE '%@lid'")[0].n, 0, 'no @lid chat rows remain');
    assert.strictEqual(q("SELECT in_waha FROM messages WHERE msg_key = '64277777777@c.us|LID00000000000000001'")[0].in_waha, 1);

    // group sender that was an @lid is shown as the phone number; participant parsed from the id
    const gnew = q("SELECT * FROM messages WHERE stanza_id = 'GRPNEW00000000000001'")[0];
    assert.strictEqual(gnew.sender_jid, '64277777777@c.us'); assert.strictEqual(gnew.chat_id, '120363000000@g.us');
    const gold = q("SELECT * FROM messages WHERE stanza_id = 'GRP0000000000000001'")[0];
    assert.strictEqual(gold.sender_jid, '64222222222@c.us'); assert.strictEqual(gold.in_waha, 1);

    // chat whose id came as { _serialized }, outgoing message with "to": null
    const np = q("SELECT * FROM messages WHERE chat_id = '64288888888@c.us'")[0];
    assert(np && np.from_me === 1 && np.sender_jid === null && np.text === 'hi new person');
    assert.strictEqual(q("SELECT name FROM chats WHERE chat_id = '64288888888@c.us'")[0].name, 'NewPerson');
    assert.strictEqual(q("SELECT COUNT(*) n FROM chats WHERE chat_id LIKE '%@broadcast' OR chat_id LIKE '%@newsletter'")[0].n, 0);

    // new text row
    const nt = q("SELECT * FROM messages WHERE stanza_id = 'NEWWAHA00000000001'")[0];
    assert.strictEqual(nt.source, 'waha'); assert.strictEqual(nt.type, 'text'); assert.strictEqual(nt.sender_name, 'Alice Push');
    assert.strictEqual(nt.waha_media_state, null);

    // media: overlap image already has backup media -> skip; new image downloaded; expired one pending (1 failed attempt)
    assert.strictEqual(q("SELECT waha_media_state s FROM messages WHERE stanza_id = 'IMG0000000000000001'")[0].s, 'skip');
    const ni = q("SELECT * FROM messages WHERE stanza_id = 'NEWIMG0000000000001'")[0];
    assert.strictEqual(ni.waha_media_state, 'done'); assert.strictEqual(ni.type, 'image');
    const savedFile = path.join(FX, 'data', 'media', ni.waha_media_path);
    assert(fs.existsSync(savedFile), 'media file saved'); assert.strictEqual(fs.readFileSync(savedFile, 'utf8'), 'FAKE-JPEG-BYTES-1');
    assert(/^[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/.test(ni.waha_media_path), ni.waha_media_path);
    const expired = q("SELECT * FROM messages WHERE stanza_id = 'NEWIMG0000000000002'")[0];
    assert.strictEqual(expired.waha_media_state, 'pending'); assert.strictEqual(expired.waha_media_attempts, 1); assert.strictEqual(expired.type, 'video');

    // paging: page size 2 over a 5-message chat -> offsets 0,2,4,6 (stops on the empty page)
    let log = await fetch('http://localhost:4010/__log').then((r) => r.json());
    const aliceOffsets = log.filter((u) => u.includes('/chats/64211111111%40c.us/messages?')).map((u) => new URL(u, 'http://x').searchParams.get('offset'));
    assert.deepStrictEqual(aliceOffsets, ['0', '2', '4', '6'], 'paged until an empty page');
    assert(log.filter((u) => u.includes('/messages?')).every((u) => u.includes('downloadMedia=false')), 'history paging never downloads media');
    assert(!log.some((u) => u.includes('filter.timestamp.gte')), 'first sync is a full read');

    // ================= webhook =================
    const hookMsg = { id: 'evt_1', event: 'message.any', session: 'default', payload: {
      id: 'false_64211111111@c.us_WEBHOOK0000000001', timestamp: T(), from: '64211111111@c.us', fromMe: false, body: 'live msg', hasMedia: true,
      media: { url: 'http://localhost:3000/api/files/default/img1.jpg', mimetype: 'image/jpeg' }, _data: { Message: { imageMessage: {} } } } };
    assert.strictEqual(await hook(hookMsg, 'deadbeef'), 401, 'bad signature rejected');
    assert.strictEqual(q("SELECT COUNT(*) n FROM messages WHERE stanza_id = 'WEBHOOK0000000001'")[0].n, 0);
    assert.strictEqual(await hook(hookMsg), 200);
    const live = (await until(async () => { const r = q("SELECT * FROM messages WHERE stanza_id = 'WEBHOOK0000000001'")[0]; return r && r.waha_media_state === 'done' ? r : null; }, 'webhook media'));
    assert.strictEqual(live.text, 'live msg'); assert.strictEqual(live.source, 'waha'); assert(fs.existsSync(path.join(FX, 'data', 'media', live.waha_media_path)));
    assert.strictEqual(await hook(hookMsg), 200); // WAHA retry / second event: no duplicate
    assert.strictEqual(q("SELECT COUNT(*) n FROM messages WHERE stanza_id = 'WEBHOOK0000000001'")[0].n, 1);
    assert.strictEqual(await hook({ event: 'message.edited', session: 'default', payload: { id: 'x' } }), 200);
    assert.strictEqual(q('SELECT COUNT(*) n FROM webhook_unhandled')[0].n, 1, 'unhandled event kept for inspection');
    assert.strictEqual(await hook({ ...hookMsg, session: 'other', payload: { ...hookMsg.payload, id: 'false_64211111111@c.us_OTHERSESSION0001' } }), 200);
    assert.strictEqual(q("SELECT COUNT(*) n FROM messages WHERE stanza_id = 'OTHERSESSION0001'")[0].n, 0, 'other session ignored');

    // ================= run 2: restart -> incremental sync, retry of failed media =================
    const finished1 = s.sync.last_finished;
    const before = q('SELECT COUNT(*) n FROM messages')[0].n;
    server.kill(); await sleep(500);
    server = startServer();
    s = await waitSyncDone(null);
    assert.strictEqual(s.sync.last_status, 'done');
    log = await fetch('http://localhost:4010/__log').then((r) => r.json());
    assert(log.some((u) => u.includes('filter.timestamp.gte=')), 'second sync is incremental');
    assert.strictEqual(q('SELECT COUNT(*) n FROM messages')[0].n, before, 'no duplicates after re-sync');
    const expired2 = q("SELECT * FROM messages WHERE stanza_id = 'NEWIMG0000000000002'")[0];
    assert.strictEqual(expired2.waha_media_state, 'failed', 'gives up after max attempts'); assert.strictEqual(expired2.waha_media_attempts, 2);
    assert.strictEqual(s.messages_by_source.reduce((a, r) => a + r.n, 0), before);
    void finished1;

    console.log('STAGE 2: ALL CHECKS PASSED');
  } finally {
    killAll();
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });

function T() { return 1790000300; }
