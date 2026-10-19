// Decrypts a WhatsApp Android crypt15 backup (end-to-end encrypted backup) with the user's 64-digit key.
// Format (as implemented by wa-crypt-tools, checked here against a real file):
//   [1 byte header size][optional 0x01][protobuf header, holds the 16-byte IV]
//   [AES-256-GCM encrypted, zlib-compressed SQLite database][16-byte GCM tag][16-byte MD5 checksum]
// The AES key is derived from the 32-byte root key: HMAC-SHA256 with a zero seed, then one HMAC round
// over "backup encryption" + 0x01. Nothing here ever logs or stores the key.
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

function hmac(key, ...parts) {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
}

// The key file is the 64 hex digits on one line, or WhatsApp's own encrypted_backup.key
// (a serialized Java byte array whose last 32 bytes are the root key).
function readRootKey(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch (e) { throw new Error(`cannot read the key file (${e.code || e.message})`); }
  const text = raw.toString('utf8').replace(/\s+/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (raw.length >= 32 && raw.length < 200 && raw[0] === 0xac && raw[1] === 0xed) return raw.subarray(raw.length - 32);
  throw new Error('the key file must hold the 64-digit key (hex) on one line, or be WhatsApp\'s encrypted_backup.key');
}

// The key comes from ANDROID_KEY (the 64 hex digits themselves) or, if that is empty, from a key file.
function rootKeyFrom({ key, keyFile }) {
  if (key && String(key).trim()) {
    const hex = String(key).replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ANDROID_KEY must be exactly 64 hex digits (0-9 and a-f)');
    return Buffer.from(hex, 'hex');
  }
  if (keyFile) return readRootKey(keyFile);
  throw new Error('no key: set ANDROID_KEY (64 hex digits) or ANDROID_KEY_FILE');
}

function deriveKey(root) {
  const privateKey = hmac(Buffer.alloc(32), root);
  return hmac(privateKey, Buffer.alloc(0), Buffer.from('backup encryption'), Buffer.from([1]));
}

function varint(buf, pos) {
  let result = 0; let shift = 0;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
}

// Minimal protobuf walk: BackupPrefix.field 3 (c15_iv) -> field 1 = the 16-byte IV.
function findIv(header) {
  let pos = 0;
  while (pos < header.length) {
    let tag; [tag, pos] = varint(header, pos);
    const field = tag >> 3; const wire = tag & 7;
    if (wire === 0) { [, pos] = varint(header, pos); }
    else if (wire === 2) {
      let len; [len, pos] = varint(header, pos);
      if (field === 3) {
        const inner = header.subarray(pos, pos + len);
        let p = 0;
        while (p < inner.length) {
          let t; [t, p] = varint(inner, p);
          if ((t & 7) !== 2) break;
          let l; [l, p] = varint(inner, p);
          if ((t >> 3) === 1 && l === 16) return inner.subarray(p, p + 16);
          p += l;
        }
      }
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else break;
  }
  return null;
}

async function decryptCrypt15(inFile, outFile, keySource) {
  const root = rootKeyFrom(keySource);
  if (root.length !== 32) throw new Error('the key must be 32 bytes (64 hex digits)');
  const aesKey = deriveKey(root);
  const size = fs.statSync(inFile).size;
  const fd = fs.openSync(inFile, 'r');
  let iv; let tag; let dataStart;
  try {
    const head = Buffer.alloc(Math.min(300, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const protoSize = head[0];
    let pos = 1;
    if (head[pos] === 1) pos += 1; // feature-table flag (msgstore only)
    iv = findIv(head.subarray(pos, pos + protoSize));
    dataStart = pos + protoSize;
    tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, size - 32);
  } finally { fs.closeSync(fd); }
  if (!iv) throw new Error('not a crypt15 file (no IV in the header)');
  if (size < dataStart + 33) throw new Error('file is too small to be a backup');

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(inFile, { start: dataStart, end: size - 33 }),
      decipher,
      zlib.createInflate(),
      fs.createWriteStream(outFile),
    );
  } catch (e) {
    try { fs.rmSync(outFile, { force: true }); } catch (_) { /* ignore */ }
    if (/authenticate|auth/i.test(e.message)) throw new Error('wrong key for this backup (authentication failed)');
    if (/incorrect header check|invalid|unexpected end/i.test(e.message)) throw new Error('wrong key or damaged file (the data did not decrypt cleanly)');
    throw e;
  }
}

module.exports = { decryptCrypt15, readRootKey, rootKeyFrom, deriveKey };
