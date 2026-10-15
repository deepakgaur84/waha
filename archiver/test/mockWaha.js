// A small fake WAHA for testing the archiver's sync. Mimics the documented API shapes.
const express = require('/tmp/claude-0/-home-claude/c2aa04bd-c895-597b-874d-73980ec4794b/scratchpad/waha-archiver-v2/app/node_modules/express');

const PORT = parseInt(process.argv[2] || '4010', 10);
const KEY = 'secret';
const app = express();
const log = [];

app.use((req, res, next) => {
  if (req.path === '/__log') return next();
  log.push(req.originalUrl);
  if (req.get('x-api-key') !== KEY) return res.status(401).json({ message: 'Unauthorized' });
  return next();
});

const T = 1790000000; // 2026, after any fixture backup message
const msg = (id, ts, body, extra = {}) => ({ id, timestamp: ts, fromMe: id.startsWith('true_'), body, hasMedia: false, ack: 3, ...extra });

const MESSAGES = {
  '64211111111@c.us': [
    msg('false_64211111111@c.us_96E48E72D8E53CA026BCBCFA53FBD0DC', 1698138479, 'hello', { from: '64211111111@c.us' }),
    msg('true_64211111111@c.us_IMG0000000000000001', 1698138539, null, { hasMedia: true, media: { url: null, mimetype: 'image/jpeg' }, _data: { Message: { imageMessage: {} } } }),
    msg('false_64211111111@c.us_NEWWAHA00000000001', T, 'new from waha', { from: '64211111111@c.us', _data: { Info: { PushName: 'Alice Push' } } }),
    msg('false_64211111111@c.us_NEWIMG0000000000001', T + 100, null, { hasMedia: true, media: { url: null, mimetype: 'image/jpeg' }, _data: { Message: { imageMessage: {} } } }),
    msg('false_64211111111@c.us_NEWIMG0000000000002', T + 200, null, { hasMedia: true, media: { url: null, mimetype: 'video/mp4' }, _data: { Message: { videoMessage: {} } } }),
  ],
  '120363000000@g.us': [
    msg('false_120363000000@g.us_GRP0000000000000001_64222222222@c.us', 1698138599, 'group hi', { participant: '64222222222@c.us' }),
    msg('false_120363000000@g.us_GRP0000000000000002_64233333333@c.us', 1698138659, 'carol here', { participant: '64233333333@c.us' }),
    msg('false_120363000000@g.us_GRPNEW00000000000001_145483494371461@lid', T + 50, 'from a lid sender', { participant: '145483494371461@lid' }),
  ],
  '145483494371461@lid': [
    msg('false_145483494371461@lid_LID00000000000000001', 1698138779, 'from lid', {}),
    msg('false_145483494371461@lid_LIDNEW0000000000001', T + 60, 'new lid message', {}),
  ],
  '64288888888@c.us': [msg('true_64288888888@c.us_NEWPERSON000000001', T + 70, 'hi new person', { to: null })],
  'broken@c.us': [],
};

app.get('/api/sessions/default', (_req, res) => res.json({ name: 'default', status: 'WORKING' }));

app.get('/api/default/lids', (req, res) => {
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(offset === 0 ? [{ lid: '145483494371461@lid', pn: '64277777777@c.us' }, { lid: '999@lid', pn: null }] : []);
});

const CHATS = [
  { id: '64211111111@c.us', name: 'Alice WAHA' },
  { id: '120363000000@g.us', name: 'Family' },
  { id: '145483494371461@lid', name: 'Lid WAHA' },
  { id: 'status@broadcast', name: 'Status' },
  { id: '999@newsletter', name: 'A channel' },
  { id: { _serialized: '64288888888@c.us' }, name: 'NewPerson' },
  { id: 'broken@c.us', name: 'Broken' },
];
app.get('/api/default/chats', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(CHATS.slice(offset, offset + limit));
});

app.get('/api/default/chats/:chatId/messages', (req, res) => {
  const chatId = req.params.chatId;
  if (chatId === 'broken@c.us') return res.status(500).json({ message: 'boom' });
  const limit = parseInt(req.query.limit || '10', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  const gte = req.query['filter.timestamp.gte'] ? parseInt(req.query['filter.timestamp.gte'], 10) : 0;
  const all = (MESSAGES[chatId] || []).filter((m) => m.timestamp >= gte);
  res.json(all.slice(offset, offset + limit)); // newest/oldest order is not guaranteed by WAHA either
});

// Single message, with media download.
app.get('/api/default/chats/:chatId/messages/:messageId', (req, res) => {
  const all = Object.values(MESSAGES).flat();
  const m = all.find((x) => x.id === req.params.messageId);
  if (!m) return res.status(404).json({ message: 'not found' });
  if (m.id.endsWith('NEWIMG0000000000001')) {
    return res.json({ ...m, media: { url: 'http://localhost:3000/api/files/default/img1.jpg', mimetype: 'image/jpeg' } });
  }
  return res.json({ ...m, media: { url: null, mimetype: m.media && m.media.mimetype, error: { message: 'not available' } } }); // simulates an expired file
});

app.get('/api/files/default/img1.jpg', (_req, res) => res.type('image/jpeg').send(Buffer.from('FAKE-JPEG-BYTES-1')));

app.get('/__log', (_req, res) => res.json(log));
app.listen(PORT, () => console.log(`mock WAHA on ${PORT}`));
