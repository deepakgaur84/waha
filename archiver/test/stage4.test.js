// Stage 4 checks: search, reactions, edits, deletions, profile photos. Run: node stage4.test.js (from this folder)
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4-'));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, 'a.db');
const APP = path.join(__dirname, '..', 'waha-archiver-v2', 'app', 'src');
const req = (m) => require(path.join(APP, m));

// Mock WAHA: picture endpoint + a fake CDN image served over plain http is refused (https only), so use none/err cases.
const express = require(path.join(APP, '..', 'node_modules', 'express'));
const mock = express();
mock.get('/api/default/chats/:id/picture', (r, res) => {
  if (r.params.id.startsWith('64210000002')) return res.json({ url: null });
  if (r.params.id.startsWith('64210000003')) return res.status(404).json({ error: 'nope' });
  return res.json({ url: 'http://example.invalid/pic.jpg' }); // not https -> counted as error, retried later
});
let mockServer;

(async () => {
  await new Promise((r) => { mockServer = mock.listen(0, r); });
  process.env.WAHA_BASE_URL = `http://127.0.0.1:${mockServer.address().port}`;

  const { db } = req('db.js');
  const ins = db.prepare(`INSERT INTO messages (msg_key, chat_id, stanza_id, id_source, from_me, ts, type, text, source)
                          VALUES (?, ?, ?, 'stanza', ?, ?, 'text', ?, 'waha')`);
  const chat = '64210000001@c.us';
  const base = 1790000000;
  ins.run(`${chat}|AAA1`, chat, 'AAA1', 0, base + 1, 'Happy birthday to you');
  ins.run(`${chat}|AAA2`, chat, 'AAA2', 1, base + 2, 'Thanks! Café tomorrow?');
  ins.run(`${chat}|AAA3`, chat, 'AAA3', 0, base + 3, 'Yes see you at the cafe');
  for (let i = 4; i < 120; i += 1) ins.run(`${chat}|B${i}`, chat, `B${i}`, i % 2, base + i, `filler ${i}`);
  db.prepare("INSERT INTO chats (chat_id, kind, name) VALUES (?, 'private', 'Test Person')").run(chat);
  const status = 'status@broadcast';
  ins.run(`${status}|S1`, status, 'S1', 0, base + 5, 'birthday status update');
  // a WAHA protocol row: must be hidden
  db.prepare(`INSERT INTO messages (msg_key, chat_id, stanza_id, id_source, from_me, ts, type, text, source)
              VALUES (?, ?, 'P1', 'stanza', 0, ?, 'system', NULL, 'waha')`).run(`${chat}|P1`, chat, base + 6);

  const reader = req('reader.js');
  const webhook = req('webhook.js');
  const app = express();
  app.use(webhook.router);
  app.use('/r', reader.router);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = srv.address().port;
  const call = (method, url, body) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const rq = http.request({ host: '127.0.0.1', port, path: url, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (_) { resolve({ status: res.statusCode, json: null }); } });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
  const hook = (event, payload) => call('POST', '/webhook', { event, session: 'default', payload });

  // ---- search
  let r = (await call('GET', '/r/search?q=birth')).json;
  assert.deepStrictEqual(r.results.map((x) => x.id), [`${chat}|AAA1`], 'prefix search finds the message, status chat hidden');
  assert.ok(r.results[0].snippet.includes('\u0001'), 'snippet has highlight markers');
  r = (await call('GET', '/r/search?q=cafe')).json;
  assert.strictEqual(r.results.length, 2, 'accent-insensitive: Café and cafe');
  r = (await call('GET', '/r/search?q=' + encodeURIComponent('see you'))).json;
  assert.strictEqual(r.results.length, 1);
  r = (await call('GET', '/r/search?q=%22%20OR%20%28')).json;
  assert.ok(Array.isArray(r.results), 'odd input does not crash');
  console.log('search ok');

  // ---- hidden protocol row
  const page = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&limit=300`)).json;
  assert.ok(!page.some((m) => m.id.endsWith('|P1')), 'protocol row hidden');
  assert.strictEqual(page.length, 119);

  // ---- reactions
  assert.strictEqual((await hook('message.reaction', { id: 'false_x', timestamp: base + 10, from: chat, fromMe: false, participant: null, reaction: { text: '👍', messageId: `true_${chat}_AAA2` } })).status, 200);
  await hook('message.reaction', { id: 'true_y', timestamp: base + 11, from: chat, fromMe: true, reaction: { text: '👍', messageId: `false_${chat}_AAA1` } });
  await hook('message.reaction', { id: 'false_z', timestamp: base + 12, from: chat, fromMe: false, reaction: { text: '❤️', messageId: `true_${chat}_AAA2` } });
  let m = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&limit=300`)).json;
  const byId = (id) => m.find((x) => x.id === id);
  assert.deepStrictEqual(byId(`${chat}|AAA2`).reactions.map((x) => x.emoji), ['❤️'], 'later reaction replaces the same person\'s earlier one');
  assert.strictEqual(byId(`${chat}|AAA1`).reactions[0].mine, true);
  await hook('message.reaction', { id: 'false_w', timestamp: base + 13, from: chat, fromMe: false, reaction: { text: '', messageId: `true_${chat}_AAA2` } });
  m = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&limit=300`)).json;
  assert.strictEqual(byId(`${chat}|AAA2`).reactions.length, 0, 'empty text removes it');
  console.log('reactions ok');

  // ---- edit, then edit again, then replay of the first (out of order) must not roll back
  await hook('message.edited', { id: 'false_e1', timestamp: base + 20, from: chat, fromMe: false, body: 'Happy birthday!!', editedMessageId: 'aaa1' });
  await hook('message.edited', { id: 'false_e2', timestamp: base + 30, from: chat, fromMe: false, body: 'Happy birthday, friend', editedMessageId: 'AAA1' });
  await hook('message.edited', { id: 'false_e1', timestamp: base + 20, from: chat, fromMe: false, body: 'Happy birthday!!', editedMessageId: 'AAA1' });
  m = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&limit=300`)).json;
  assert.strictEqual(byId(`${chat}|AAA1`).text, 'Happy birthday, friend');
  assert.strictEqual(byId(`${chat}|AAA1`).edited, true);
  const hist = (await call('GET', `/r/messages/edits?chat=${encodeURIComponent(chat)}&key=${encodeURIComponent(chat + '|AAA1')}`)).json;
  assert.deepStrictEqual(hist.map((h) => h.text), ['Happy birthday to you', 'Happy birthday!!', 'Happy birthday, friend']);
  r = (await call('GET', '/r/search?q=friend')).json;
  assert.strictEqual(r.results.length, 1, 'search sees the edited text');
  r = (await call('GET', '/r/search?q=' + encodeURIComponent('to you'))).json;
  assert.strictEqual(r.results.length, 0, 'old text no longer indexed');
  console.log('edits ok');

  // ---- revoke
  await hook('message.revoked', { revokedMessageId: 'AAA3', after: { timestamp: base + 40 } });
  m = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&limit=300`)).json;
  assert.strictEqual(byId(`${chat}|AAA3`).deleted, true);
  assert.strictEqual(byId(`${chat}|AAA3`).text, 'Yes see you at the cafe', 'content is kept');
  // event before the message exists
  await hook('message.reaction', { id: 'x', timestamp: base + 50, from: chat, fromMe: false, reaction: { text: '😂', messageId: `true_${chat}_LATE1` } });
  ins.run(`${chat}|LATE1`, chat, 'LATE1', 1, base + 49, 'arrives later');
  m = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&limit=300`)).json;
  assert.strictEqual(byId(`${chat}|LATE1`).reactions[0].emoji, '😂', 'reaction stored before its message still attaches');
  // unexpected shape is kept raw, not lost
  await hook('message.reaction', { weird: true });
  assert.ok(db.prepare("SELECT COUNT(*) n FROM webhook_unhandled WHERE event='message.reaction'").get().n >= 1);
  console.log('revoke + ordering ok');

  // ---- replay of events stored raw by the previous version
  db.prepare("INSERT INTO webhook_unhandled (received_at, event, body) VALUES (1, 'message.revoked', ?)").run(JSON.stringify({ event: 'message.revoked', payload: { revokedMessageId: 'AAA2', after: { timestamp: base + 60 } } }));
  const { replayStored } = req('events.js');
  const rep = replayStored();
  assert.ok(rep.applied >= 1);
  m = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&limit=300`)).json;
  assert.strictEqual(byId(`${chat}|AAA2`).deleted, true);
  console.log('replay ok');

  // ---- around + newer paging
  const around = (await call('GET', `/r/messages/around?chat=${encodeURIComponent(chat)}&key=${encodeURIComponent(chat + '|B60')}`)).json;
  const ids = around.messages.map((x) => x.id);
  assert.ok(ids.includes(`${chat}|B60`));
  assert.strictEqual(around.has_newer, true);
  assert.strictEqual(around.no_more_older, false);
  const last = around.messages[around.messages.length - 1];
  const newer = (await call('GET', `/r/messages?chat=${encodeURIComponent(chat)}&after=${encodeURIComponent(last.cur)}&limit=100`)).json;
  assert.ok(newer.length > 0 && newer[0].date >= last.date);
  assert.ok(!newer.some((x) => ids.includes(x.id)), 'no overlap with the window');
  const missing = await call('GET', `/r/messages/around?chat=${encodeURIComponent(chat)}&key=nope`);
  assert.strictEqual(missing.status, 404);
  console.log('around ok');

  // ---- avatars
  db.prepare("INSERT INTO chats (chat_id, kind, name) VALUES ('64210000002@c.us','private','No Pic')").run();
  db.prepare("INSERT INTO chats (chat_id, kind, name) VALUES ('64210000003@c.us','private','Hidden')").run();
  ins.run('64210000002@c.us|N1', '64210000002@c.us', 'N1', 0, base + 1, 'x');
  ins.run('64210000003@c.us|N1', '64210000003@c.us', 'N1', 0, base + 2, 'y');
  const av = req('avatars.js');
  const stats = await av.syncAvatars();
  const rows = db.prepare('SELECT jid, status FROM avatars ORDER BY jid').all();
  assert.deepStrictEqual(rows.filter((x) => x.jid.startsWith('6421000000[23]'.slice(0, 9)) && x.status === 'none').map((x) => x.jid), ['64210000002@c.us', '64210000003@c.us']);
  assert.ok(!rows.some((x) => x.jid === 'status@broadcast'), 'skipped suffixes are not looked up');
  assert.strictEqual(rows.find((x) => x.jid === chat), undefined, 'a failed download is not recorded as "no picture"');
  // a stored picture is served
  const dir = path.join(tmp, 'media', 'avatars'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  db.prepare("INSERT OR REPLACE INTO avatars (jid, file, status, checked_at) VALUES (?, 'x.jpg', 'ok', ?)").run(chat, Math.floor(Date.now() / 1000));
  const img = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/r/avatar?jid=${encodeURIComponent(chat)}` }, (res) => { res.resume(); res.on('end', () => resolve(res)); }));
  assert.strictEqual(img.statusCode, 200);
  assert.strictEqual(img.headers['content-type'], 'image/jpeg');
  assert.strictEqual((await call('GET', '/r/avatar?jid=../../etc/passwd')).status, 404);
  reader.invalidateChats();
  const chats = (await call('GET', '/r/chats')).json;
  assert.strictEqual(chats.find((c) => c.id === chat).has_avatar, true);
  assert.ok(!chats.some((c) => c.id === 'status@broadcast'));
  console.log('avatars ok', stats);

  console.log('STAGE 4: ALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
