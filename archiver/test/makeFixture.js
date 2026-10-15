// Builds a tiny fake iOS backup (two snapshots) using the real column names
// seen in the user's /api/debug/schema output.
const fs = require('fs');
const path = require('path');
const Database = require('/tmp/claude-0/-home-claude/c2aa04bd-c895-597b-874d-73980ec4794b/scratchpad/waha-archiver-v2/app/node_modules/better-sqlite3');

const root = process.argv[2];
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'backup', 'waha'), { recursive: true });          // decoy: archive folder, no Manifest.db
fs.mkdirSync(path.join(root, 'backup', 'waha-archive'), { recursive: true });  // decoy: old archive folder

const MAC = 978307200;
const mac = (unix) => unix - MAC;
const PROBE_TS = 1698138479; // 2023-10-24T09:07:59Z, the message seen in WAHA

function makeSnapshot(name, withExtra, mediaOnDisk) {
  const dir = path.join(root, 'backup', name);
  fs.mkdirSync(dir, { recursive: true });

  // ---- ChatStorage.sqlite
  const csFileId = 'ab' + 'c'.repeat(38);
  fs.mkdirSync(path.join(dir, csFileId.slice(0, 2)), { recursive: true });
  const csPath = path.join(dir, csFileId.slice(0, 2), csFileId);
  const cs = new Database(csPath);
  cs.exec(`
    CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT, ZSESSIONTYPE INTEGER, ZLASTMESSAGEDATE REAL);
    CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT, ZFIRSTNAME TEXT);
    CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, ZJID TEXT, ZPUSHNAME TEXT);
    CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMESSAGE INTEGER, ZMEDIALOCALPATH TEXT, ZTITLE TEXT, ZFILESIZE INTEGER);
    CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZSTANZAID TEXT, ZISFROMME INTEGER,
      ZFROMJID TEXT, ZTOJID TEXT, ZGROUPMEMBER INTEGER, ZMESSAGEDATE REAL, ZMESSAGETYPE INTEGER, ZTEXT TEXT,
      ZPUSHNAME TEXT, ZSTARRED INTEGER);
  `);
  cs.prepare('INSERT INTO ZWACHATSESSION VALUES (?,?,?,?,?)').run(1, '64211111111@s.whatsapp.net', 'Alice', 0, mac(PROBE_TS));
  cs.prepare('INSERT INTO ZWACHATSESSION VALUES (?,?,?,?,?)').run(2, '120363000000@g.us', 'Family', 1, mac(PROBE_TS));
  cs.prepare('INSERT INTO ZWACHATSESSION VALUES (?,?,?,?,?)').run(3, 'status@broadcast', 'Status', 3, mac(PROBE_TS));
  cs.prepare('INSERT INTO ZWACHATSESSION VALUES (?,?,?,?,?)').run(4, null, 'No JID', 0, mac(PROBE_TS));
  cs.prepare('INSERT INTO ZWACHATSESSION VALUES (?,?,?,?,?)').run(5, '145483494371461@lid', 'Lid person', 0, mac(PROBE_TS));
  cs.prepare('INSERT INTO ZWAGROUPMEMBER VALUES (?,?,?,?)').run(1, '64222222222@s.whatsapp.net', 'Bob', null);
  cs.prepare('INSERT INTO ZWAGROUPMEMBER VALUES (?,?,?,?)').run(2, '64233333333@s.whatsapp.net', 'Zm9v=', 'Carol'); // opaque name -> falls back to first name
  cs.prepare('INSERT INTO ZWAPROFILEPUSHNAME VALUES (?,?,?)').run(1, '64211111111@s.whatsapp.net', 'Alice Push');

  const m = cs.prepare('INSERT INTO ZWAMESSAGE (Z_PK,ZCHATSESSION,ZSTANZAID,ZISFROMME,ZFROMJID,ZTOJID,ZGROUPMEMBER,ZMESSAGEDATE,ZMESSAGETYPE,ZTEXT,ZPUSHNAME,ZSTARRED) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  // 1: incoming text, lowercase stanza id (must be upper-cased); date = the WAHA probe message
  m.run(1, 1, '96e48e72d8e53ca026bcbcfa53fbd0dc', 0, '64211111111@s.whatsapp.net', null, null, mac(PROBE_TS), 0, 'hello', null, 0);
  // 2: outgoing image with media
  m.run(2, 1, 'IMG0000000000000001', 1, null, '64211111111@s.whatsapp.net', null, mac(PROBE_TS + 60), 1, null, null, 1);
  // 3: group message from Bob
  m.run(3, 2, 'GRP0000000000000001', 0, '120363000000@g.us', null, 1, mac(PROBE_TS + 120), 0, 'group hi', null, 0);
  // 4: group message from Carol (opaque contact name)
  m.run(4, 2, 'GRP0000000000000002', 0, '120363000000@g.us', null, 2, mac(PROBE_TS + 180), 0, 'carol here', null, 0);
  // 5: system message without a stanza id
  m.run(5, 2, null, 0, '120363000000@g.us', null, null, mac(PROBE_TS + 240), 10, null, null, 0);
  // 6: message with no date -> skipped
  m.run(6, 1, 'NODATE0000000000001', 0, '64211111111@s.whatsapp.net', null, null, null, 0, 'no date', null, 0);
  // 7: message in a status session -> skipped (no chat)
  m.run(7, 3, 'STATUS000000000001', 0, 'status@broadcast', null, null, mac(PROBE_TS), 0, 'status', null, 0);
  // 8: message in the @lid chat
  m.run(8, 5, 'LID00000000000000001', 0, '145483494371461@lid', null, null, mac(PROBE_TS + 300), 0, 'from lid', null, 0);
  if (withExtra) {
    m.run(9, 1, 'NEWMSG0000000000001', 1, null, '64211111111@s.whatsapp.net', null, mac(PROBE_TS + 400), 0, 'only in newer snapshot', null, 0);
  }

  const relMedia = 'Media/64211111111@s.whatsapp.net/a/b/photo-guid';        // note: no extension
  cs.prepare('INSERT INTO ZWAMEDIAITEM VALUES (?,?,?,?,?)').run(1, 2, relMedia, 'photo', 12345);
  cs.close();

  // ---- media file (hash id in Manifest, named with an extension)
  const mediaFileId = 'de' + 'f'.repeat(38);
  if (mediaOnDisk) {
    fs.mkdirSync(path.join(dir, mediaFileId.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(dir, mediaFileId.slice(0, 2), mediaFileId), 'fake jpeg bytes');
  }

  // ---- Manifest.db
  const mf = new Database(path.join(dir, 'Manifest.db'));
  mf.exec('CREATE TABLE Files (fileID TEXT, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)');
  const f = mf.prepare('INSERT INTO Files VALUES (?,?,?,?,NULL)');
  f.run(csFileId, 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite', 1);
  f.run(mediaFileId, 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared', 'Message/' + relMedia + '.jpg', 1);
  f.run('99' + '0'.repeat(38), 'HomeDomain', 'Library/Other/unrelated.txt', 1); // must be ignored
  mf.close();
}

makeSnapshot('00008030-TEST_20260101000000_WhatsApp', false, false); // older: media listed but file absent
makeSnapshot('00008030-TEST_20260720151456_WhatsApp', true, true);   // newer: one extra message, media present
console.log('fixture ready at', root);
