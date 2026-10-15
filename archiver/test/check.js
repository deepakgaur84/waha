// Assertions on the archive database after the importer ran on the fixture.
const assert = require('assert');
const Database = require('/tmp/claude-0/-home-claude/c2aa04bd-c895-597b-874d-73980ec4794b/scratchpad/waha-archiver-v2/app/node_modules/better-sqlite3');

const [dbPath, reportPath, expectRun] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });
const report = JSON.parse(require('fs').readFileSync(reportPath, 'utf8'));
const msg = (key) => db.prepare('SELECT * FROM messages WHERE msg_key = ?').get(key);

// Snapshot A holds 5 importable messages from msgs 1,2,3,4,5,8 = 6 (msg 6 no date, msg 7 status session)
// Snapshot B adds NEWMSG -> 7 in total. Duplicates across snapshots must not add rows.
const total = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
assert.strictEqual(total, 7, `total messages ${total}`);

// chats: private, group, lid. Status and null-jid sessions are not chats.
const chats = db.prepare('SELECT chat_id, kind, name FROM chats ORDER BY chat_id').all();
assert.deepStrictEqual(chats.map((c) => c.chat_id), [
  '120363000000@g.us', '145483494371461@lid', '64211111111@c.us',
]);
assert.strictEqual(chats.find((c) => c.chat_id === '120363000000@g.us').kind, 'group');
assert.strictEqual(chats.find((c) => c.chat_id === '64211111111@c.us').name, 'Alice');

// stanza ids upper-cased and keyed on chat + id (same as WAHA's id suffix)
const hello = msg('64211111111@c.us|96E48E72D8E53CA026BCBCFA53FBD0DC');
assert(hello, 'probe message present');
assert.strictEqual(hello.ts, 1698138479);
assert.strictEqual(hello.text, 'hello');
assert.strictEqual(hello.sender_jid, '64211111111@c.us');
assert.strictEqual(hello.sender_name, 'Alice Push');
assert.strictEqual(hello.id_source, 'stanza');
assert.strictEqual(hello.first_snapshot, '00008030-TEST_20260101000000_WhatsApp');

// media: absent in the older snapshot, found in the newer one -> filled in, row not duplicated
const img = msg('64211111111@c.us|IMG0000000000000001');
assert.strictEqual(img.type, 'image');
assert.strictEqual(img.from_me, 1);
assert.strictEqual(img.starred, 1);
assert.strictEqual(img.media_on_disk, 1, 'media found via newer snapshot');
assert.strictEqual(img.media_snapshot, '00008030-TEST_20260720151456_WhatsApp');
assert.strictEqual(img.media_file_id, 'de' + 'f'.repeat(38));
assert.strictEqual(img.media_size, 12345);

// group senders resolved through the member table, jid normalised; opaque name falls back
const bob = msg('120363000000@g.us|GRP0000000000000001');
assert.strictEqual(bob.sender_jid, '64222222222@c.us');
assert.strictEqual(bob.sender_name, 'Bob');
const carol = msg('120363000000@g.us|GRP0000000000000002');
assert.strictEqual(carol.sender_name, 'Carol');

// message without a stanza id gets a synthetic key
const synth = db.prepare("SELECT * FROM messages WHERE id_source = 'synthetic'").all();
assert.strictEqual(synth.length, 1);
assert(synth[0].msg_key.includes('|bk:'));
assert.strictEqual(synth[0].type, 'other_10');

// @lid chat message kept under the @lid chat id
assert(msg('145483494371461@lid|LID00000000000000001'));

// last_message_ts filled in
const alice = db.prepare("SELECT last_message_ts FROM chats WHERE chat_id = '64211111111@c.us'").get();
assert.strictEqual(alice.last_message_ts, 1698138479 + 400);

// report
assert.strictEqual(report.totals.messages, 7);
assert.strictEqual(report.totals.messages_without_stanza_id, 1);
const probeFound = report.probes.find((p) => p.stanza_id === '96E48E72D8E53CA026BCBCFA53FBD0DC');
const probeMissing = report.probes.find((p) => p.stanza_id === '5E153DA8A1CA8509A667');
assert(probeFound.found && probeFound.matches[0].chat_id === '64211111111@c.us');
assert(!probeMissing.found);

const runs = db.prepare("SELECT snapshot, status FROM import_runs ORDER BY snapshot").all();
assert.strictEqual(runs.length, 2);
assert(runs.every((r) => r.status === 'done'));
if (expectRun === 'first') {
  const [a, b] = report.snapshots;
  assert.strictEqual(a.messages_read, 8, 'snapshot A reads all 8 rows');
  assert.strictEqual(a.skipped_no_date, 1);
  assert.strictEqual(a.skipped_no_chat, 1);
  assert.strictEqual(a.new_messages, 6);
  assert.strictEqual(b.new_messages, 1, 'snapshot B only adds the one new message');
  assert.strictEqual(a.media_on_disk, 0);
  assert.strictEqual(b.media_on_disk, 1);
}
console.log('ALL CHECKS PASSED (' + (expectRun || 'rerun') + ')');
