// Thin client for the WAHA REST API (endpoints checked against WAHA's docs).
const cfg = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  return cfg.wahaApiKey ? { 'X-Api-Key': cfg.wahaApiKey } : {};
}

async function request(pathAndQuery, { timeoutMs = cfg.requestTimeoutMs, retries = 3, asBuffer = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(cfg.wahaBaseUrl + pathAndQuery, {
        headers: headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const e = new Error(`WAHA ${res.status} for ${pathAndQuery.split('?')[0]}`);
        e.status = res.status;
        throw e;
      }
      if (asBuffer) {
        return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
      }
      return await res.json();
    } catch (e) {
      // Node's fetch hides the real reason in e.cause (ENOTFOUND, ECONNREFUSED, timeout...).
      if (!e.status) {
        const why = (e.cause && (e.cause.code || e.cause.message)) || (e.name === 'TimeoutError' ? 'timed out' : e.message);
        e.message = `cannot reach WAHA at ${cfg.wahaBaseUrl} (${why})`;
      }
      lastErr = e;
      const permanent = e.status && e.status < 500 && e.status !== 429 && e.status !== 408;
      if (permanent || attempt === retries) break;
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

// WAHA returns ids either as plain strings or as { _serialized: "..." }.
function idOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value._serialized || value.user || null;
  return null;
}

const S = () => encodeURIComponent(cfg.wahaSession);

// GET /api/sessions/{session} -> { name, status, ... }
function getSession() {
  return request(`/api/sessions/${S()}`, { retries: 2 });
}

// GET /api/{session}/lids?limit&offset -> [{ lid, pn }]
function getLids(limit, offset) {
  return request(`/api/${S()}/lids?limit=${limit}&offset=${offset}`);
}

// GET /api/{session}/chats?limit&offset&sortBy&sortOrder -> [{ id, name, ... }]
function getChats(limit, offset) {
  return request(`/api/${S()}/chats?limit=${limit}&offset=${offset}&sortBy=conversationTimestamp&sortOrder=desc`);
}

// GET /api/{session}/chats/{chatId}/messages?limit&offset&downloadMedia&filter.timestamp.gte
// Media is NOT downloaded while paging history: it would ask the phone to
// re-upload every old file. Media is fetched separately, only where needed.
function getMessages(chatId, { limit, offset, gte }) {
  let q = `limit=${limit}&offset=${offset}&downloadMedia=false`;
  if (gte) q += `&filter.timestamp.gte=${gte}`;
  return request(`/api/${S()}/chats/${encodeURIComponent(chatId)}/messages?${q}`);
}

// GET /api/{session}/chats/{chatId}/messages/{messageId}?downloadMedia=true
function getMessageWithMedia(chatId, messageId) {
  return request(
    `/api/${S()}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?downloadMedia=true`,
    { timeoutMs: cfg.mediaTimeoutMs, retries: 2 }
  );
}

// Downloads a media file. WAHA puts its own public hostname in media.url, so
// only the path and query are kept and sent to the configured base URL.
function downloadFile(url) {
  const u = new URL(url, cfg.wahaBaseUrl);
  return request(u.pathname + u.search, { timeoutMs: cfg.mediaTimeoutMs, retries: 2, asBuffer: true });
}

// GET /api/{session}/chats/{chatId}/picture -> { url } (null when there is none or privacy hides it)
function getChatPicture(chatId) {
  return request(`/api/${S()}/chats/${encodeURIComponent(chatId)}/picture`, { retries: 2 });
}

module.exports = { getChatPicture, getSession, getLids, getChats, getMessages, getMessageWithMedia, downloadFile, idOf };
