const API = "/reader/api";

const state = {
  chats: [],
  activeChat: null,
  oldestCursor: null,
  noMoreOlder: false,
  loadingOlder: false,
  messages: [],
  stickBottom: false,
  dateFormat: "dmy_12h",
  readerMode: "ios",
  chatSort: "latest",
  prefs: null,
  folders: [],
};

const $ = (id) => document.getElementById(id);
const chatListEl = $("chat-list");
const searchEl = $("search");
const chatTitleEl = $("chat-title");
const chatSubEl = $("chat-sub");
const chatAvatarEl = $("chat-avatar");
const appEl = $("app");
const messageListEl = $("message-list");
const messagesEl = $("messages");
const emptyHintEl = $("empty-hint");
const lightboxEl = $("lightbox");
const modeLineEl = $("mode-line");

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MODE_NAMES = { ios: "iOS backups", android: "Android backups", all: "All backups" };
const TYPE_LABELS = {
  image: "Photo", video: "Video", audio: "Audio", document: "Document", sticker: "Sticker", gif: "GIF",
  location: "Location", contact: "Contact", poll: "Poll", reaction: "Reaction", system: "System message",
};

// ---------------------------------------------------------------- helpers

async function api(path, options) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch (e) {
    throw new Error("Could not reach the server.");
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    // A logged-out session is redirected to the login page (HTML, not JSON): reload to show it.
    window.location.reload();
    throw new Error("Signed out.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function pad(n) { return String(n).padStart(2, "0"); }

function formatDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  const day = pad(d.getDate());
  const year = d.getFullYear();
  const mins = pad(d.getMinutes());
  const secs = pad(d.getSeconds());
  if (state.dateFormat === "ymd_24h") {
    return `${year}-${pad(d.getMonth() + 1)}-${day} ${pad(d.getHours())}:${mins}:${secs}`;
  }
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  if (state.dateFormat === "mdy_12h") return `${pad(d.getMonth() + 1)}/${day}/${year} ${h}:${mins}:${secs} ${ampm}`;
  return `${day}-${MONTHS[d.getMonth()]}-${year} ${h}:${mins}:${secs} ${ampm}`;
}

function formatDay(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  if (state.dateFormat === "ymd_24h") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (state.dateFormat === "mdy_12h") return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function dayKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const AVATAR_COLORS = ["#00a884", "#53bdeb", "#7f66ff", "#d9658b", "#d98b3a", "#4f9d69", "#a06cd5", "#c4685a"];

function avatar(name, sizeClass) {
  const el = document.createElement("div");
  el.className = "avatar " + sizeClass;
  const text = String(name || "?").trim();
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  el.style.background = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const letters = text.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
  el.textContent = (letters.length ? (letters[0][0] + (letters[1] ? letters[1][0] : "")) : "#").toUpperCase();
  return el;
}

// ------------------------------------------------------------- chat list

function updateModeLine() {
  modeLineEl.textContent = "";
  modeLineEl.append("Reader mode: ");
  const b = document.createElement("b");
  b.textContent = MODE_NAMES[state.readerMode] || state.readerMode;
  modeLineEl.append(b, ` · ${state.chats.length} chats`);
}

async function loadChats() {
  state.chats = await api("/chats");
  updateModeLine();
  renderChatList();
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const nameKey = (c) => c.name.trim().toLowerCase();

function sortedChats(chats) {
  const list = [...chats];
  if (state.chatSort === "name_asc") list.sort((a, b) => collator.compare(a.name, b.name) || b.last_date - a.last_date);
  else if (state.chatSort === "name_desc") list.sort((a, b) => collator.compare(b.name, a.name) || b.last_date - a.last_date);
  else if (state.chatSort === "oldest") list.sort((a, b) => a.last_date - b.last_date);
  else list.sort((a, b) => b.last_date - a.last_date);
  return list;
}

function renderChatList() {
  const q = searchEl.value.trim().toLowerCase();
  const chats = q
    ? state.chats.filter((c) => c.name.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
    : state.chats;
  // Count names over ALL chats (not just the filtered ones) so the tag stays correct while searching.
  const nameCounts = new Map();
  for (const c of state.chats) nameCounts.set(nameKey(c), (nameCounts.get(nameKey(c)) || 0) + 1);
  chatListEl.innerHTML = "";
  if (!chats.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = q
      ? "No chats match your search."
      : `No chats to show in ${MODE_NAMES[state.readerMode] || "this"} mode yet.`;
    chatListEl.appendChild(empty);
    return;
  }
  for (const chat of sortedChats(chats)) {
    const div = document.createElement("div");
    div.className = "chat-item" + (state.activeChat && chat.id === state.activeChat.id ? " active" : "");
    div.appendChild(avatar(chat.name, "avatar-sm"));
    const wrap = document.createElement("div");
    wrap.className = "chat-item-text";
    for (const [cls, text] of [
      ["name", chat.name],
      ["chat-id", chat.label],
      ["meta", `${formatDate(chat.last_date)} · ${plural(chat.count, "message")}`],
    ]) {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      if (cls === "name" && nameCounts.get(nameKey(chat)) > 1) {
        const tag = document.createElement("span");
        tag.className = "dup-badge";
        tag.textContent = `same name \u00d7${nameCounts.get(nameKey(chat))}`;
        s.appendChild(tag);
      }
      wrap.appendChild(s);
    }
    div.appendChild(wrap);
    div.addEventListener("click", () => openChat(chat));
    chatListEl.appendChild(div);
  }
}

searchEl.addEventListener("input", renderChatList);

// --------------------------------------------------------------- messages

async function openChat(chat) {
  state.activeChat = chat;
  state.oldestCursor = null;
  state.noMoreOlder = false;
  state.messages = [];
  chatTitleEl.textContent = chat.name;
  chatSubEl.textContent = `${chat.label} · ${plural(chat.count, "message")}`;
  chatAvatarEl.innerHTML = "";
  chatAvatarEl.appendChild(avatar(chat.name, "avatar-md"));
  emptyHintEl.classList.add("hidden");
  renderChatList();
  messageListEl.innerHTML = "";
  appEl.classList.add("chat-active");
  state.stickBottom = true;
  await loadMessages();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

$("back-button").addEventListener("click", () => appEl.classList.remove("chat-active"));

async function loadMessages() {
  if (state.loadingOlder || state.noMoreOlder || !state.activeChat) return;
  state.loadingOlder = true;
  const chatId = state.activeChat.id;
  let url = `/messages?chat=${encodeURIComponent(chatId)}&limit=100`;
  if (state.oldestCursor) url += `&before=${encodeURIComponent(state.oldestCursor)}`;
  try {
    const batch = await api(url);
    if (!state.activeChat || state.activeChat.id !== chatId) return; // user switched chats meanwhile
    if (batch.length) {
      state.oldestCursor = batch[0].cur;
      state.messages = [...batch, ...state.messages];
    }
    if (batch.length < 100) state.noMoreOlder = true;
    renderMessages();
  } catch (e) {
    state.noMoreOlder = true;
    messageListEl.textContent = e.message;
  } finally {
    state.loadingOlder = false;
  }
}

messagesEl.addEventListener("scroll", async () => {
  // Photos and videos change the height as they load: keep the newest message in view
  // until the reader scrolls up on their own.
  state.stickBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  if (messagesEl.scrollTop < 150 && !state.loadingOlder && !state.noMoreOlder) {
    const prev = messagesEl.scrollHeight;
    await loadMessages();
    messagesEl.scrollTop = messagesEl.scrollHeight - prev;
  }
});

function sameSender(a, b) {
  if (!a || !b) return false;
  if (a.is_from_me !== b.is_from_me) return false;
  return a.is_from_me ? true : a.from_jid === b.from_jid;
}

function renderMessages() {
  messageListEl.innerHTML = "";
  if (state.noMoreOlder && state.messages.length) {
    const note = document.createElement("div");
    note.className = "older-note";
    note.textContent = "Start of this chat in the archive";
    messageListEl.appendChild(note);
  }
  if (!state.messages.length) {
    const none = document.createElement("div");
    none.className = "older-note";
    none.textContent = "No messages to show for this chat in the current reader mode.";
    messageListEl.appendChild(none);
    return;
  }
  let prev = null;
  for (const m of state.messages) {
    const newDay = !prev || dayKey(prev.date) !== dayKey(m.date);
    if (newDay) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      const span = document.createElement("span");
      span.textContent = formatDay(m.date);
      sep.appendChild(span);
      messageListEl.appendChild(sep);
    }
    messageListEl.appendChild(renderBubble(m, !newDay && sameSender(prev, m)));
    prev = m;
  }
}

function senderLabel(m) {
  if (m.is_from_me) return "You";
  if (m.from_name) return m.from_name;
  if (m.from_jid) return "+" + m.from_jid.split("@")[0].replace(/\D/g, "");
  return "Unknown";
}

function renderBubble(m, grouped) {
  const row = document.createElement("div");
  row.className = "bubble-row" + (m.is_from_me ? " mine" : "") + (grouped ? " grouped" : "");
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (!grouped && state.activeChat.is_group) {
    const nameEl = document.createElement("div");
    nameEl.className = "sender-name";
    nameEl.textContent = senderLabel(m);
    bubble.appendChild(nameEl);
  }

  if (m.is_media) bubble.appendChild(renderMedia(m));
  if (m.text) {
    const wrap = document.createElement("div");
    wrap.appendChild(linkifyText(m.text));
    bubble.appendChild(wrap);
  } else if (!m.is_media && m.type !== "text") {
    const ph = document.createElement("span");
    ph.className = "placeholder";
    ph.textContent = `[${TYPE_LABELS[m.type] || m.type.replace(/^other_/, "message type ")}]`;
    bubble.appendChild(ph);
  }

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = formatDate(m.date);
  bubble.appendChild(meta);
  row.appendChild(bubble);
  return row;
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

// Builds links and text nodes only (no innerHTML), so message content is never read as markup.
function linkifyText(text) {
  const container = document.createElement("span");
  for (const part of text.split(URL_RE)) {
    if (!part) continue;
    if (/^https?:\/\//.test(part)) {
      const a = document.createElement("a");
      a.href = part;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "msg-link";
      a.textContent = part;
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  }
  return container;
}

function keepBottom() {
  if (state.stickBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMedia(m) {
  if (!m.has_media) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    const label = TYPE_LABELS[m.type] || "Media";
    ph.textContent = m.media_state === "pending" ? `${label} – still being downloaded` : `${label} – file not available`;
    return ph;
  }
  const src = `${API}/media?key=${encodeURIComponent(m.id)}`;
  let el;
  switch (m.type) {
    case "image":
    case "sticker":
    case "gif":
      el = document.createElement("img");
      el.src = src;
      el.addEventListener("load", keepBottom);
      el.className = "clickable-media" + (m.type === "sticker" ? " sticker" : "");
      el.addEventListener("click", () => openLightbox(src));
      break;
    case "video":
      el = document.createElement("video");
      el.src = src;
      el.controls = true;
      el.preload = "metadata";
      el.addEventListener("loadedmetadata", keepBottom);
      el.className = "clickable-media";
      break;
    case "audio":
      el = document.createElement("audio");
      el.src = src;
      el.controls = true;
      el.preload = "none";
      break;
    default: {
      el = document.createElement("a");
      el.href = src;
      el.target = "_blank";
      el.className = "doc-link";
      el.textContent = "📎 " + (m.media_title || "Attachment");
    }
  }
  return el;
}

function openLightbox(src) {
  lightboxEl.innerHTML = "";
  const el = document.createElement("img");
  el.src = src;
  lightboxEl.appendChild(el);
  lightboxEl.classList.remove("hidden");
}
function closeLightbox() {
  lightboxEl.classList.add("hidden");
  lightboxEl.innerHTML = "";
}
lightboxEl.addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeLightbox(); closePrefs(); }
});

// ----------------------------------------------------------- preferences

const prefsOverlayEl = $("prefs-overlay");
const prefsStatusEl = $("prefs-status");
const actionStatusEl = $("action-status");
let statusTimer = null;

function setStatus(el, text, cls) {
  el.textContent = text;
  el.className = cls || "";
}

function closePrefs() {
  prefsOverlayEl.classList.add("hidden");
  clearInterval(statusTimer);
  statusTimer = null;
}

async function openPrefs() {
  prefsOverlayEl.classList.remove("hidden");
  setStatus(prefsStatusEl, "");
  setStatus(actionStatusEl, "");
  await loadPrefsIntoPanel();
  clearInterval(statusTimer);
  statusTimer = setInterval(refreshStats, 5000); // keeps job progress current while the panel is open
}

$("prefs-button").addEventListener("click", openPrefs);
$("prefs-close").addEventListener("click", closePrefs);
prefsOverlayEl.addEventListener("click", (e) => { if (e.target === prefsOverlayEl) closePrefs(); });

function row(label, value) {
  const div = document.createElement("div");
  div.className = "stat-row";
  const a = document.createElement("span");
  a.textContent = label;
  const b = document.createElement("span");
  b.textContent = value;
  div.append(a, b);
  return div;
}

function renderStats(st) {
  const box = $("prefs-stats");
  box.innerHTML = "";
  const bySource = (st.by_source || [])
    .map((s) => `${s.source === "ios" ? "iOS backup" : s.source === "android" ? "Android backup" : "WAHA only"}: ${s.n.toLocaleString()}`)
    .join(" · ");
  const media = (st.waha_media || []).map((s) => `${s.state} ${s.n}`).join(" · ") || "none";
  const sync = st.sync || {};
  const imp = st.import || {};
  const stats = sync.last_stats || {};
  box.append(
    row("Messages", st.messages.toLocaleString()),
    row("Chats", st.chats.toLocaleString()),
    row("Date range", st.oldest ? `${formatDay(st.oldest)} – ${formatDay(st.newest)}` : "–"),
    row("By source", bySource || "–"),
    row("WAHA media", media),
    row("Backup import", imp.running ? "running…" : imp.finished_at ? `finished ${new Date(imp.finished_at).toLocaleString()}` : "not run since start"),
    row("WAHA sync", sync.running ? "running…" : sync.last_status ? `${sync.last_status}${sync.last_finished ? " " + new Date(sync.last_finished).toLocaleString() : ""}` : "not run yet"),
  );
  if (stats && stats.new_messages !== undefined) {
    box.append(row("Last sync result", `${stats.messages_seen ?? 0} read, ${stats.new_messages} new, ${stats.chat_errors ?? 0} chat errors`));
  }
  if (sync.last_error) box.append(row("Last sync error", sync.last_error));
  for (const btn of document.querySelectorAll(".action-btn")) {
    btn.disabled = Boolean(sync.running || imp.running || st.media_job_running);
  }
}

async function refreshStats() {
  try { renderStats(await api("/status")); } catch (e) { /* the panel keeps the last values */ }
}

const KIND_BADGES = {
  ios: ["iOS backup", "ios"],
  android: ["Android – not read", "android"],
  archive: ["archive data – not read", ""],
  other: ["other – not read", ""],
};

function renderFolders(folders, excluded) {
  const box = $("folder-list");
  box.innerHTML = "";
  if (!folders.length) {
    const none = document.createElement("div");
    none.className = "folder-empty";
    none.textContent = "No folders found in the backup directory.";
    box.appendChild(none);
    return;
  }
  for (const f of folders) {
    const rowEl = document.createElement("label");
    const isIos = f.kind === "ios";
    const off = excluded.includes(f.name);
    rowEl.className = "folder-row" + (isIos && off ? " disabled" : "");
    if (isIos) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = f.name;
      cb.checked = !off;
      cb.className = "folder-cb";
      cb.addEventListener("change", () => rowEl.classList.toggle("disabled", !cb.checked));
      rowEl.appendChild(cb);
    }
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = f.name;
    const [text, cls] = KIND_BADGES[f.kind] || KIND_BADGES.other;
    const badge = document.createElement("span");
    badge.className = "badge " + cls;
    badge.textContent = text;
    rowEl.append(name, badge);
    box.appendChild(rowEl);
  }
}

async function loadPrefsIntoPanel() {
  let data;
  try {
    data = await api("/preferences");
  } catch (e) {
    setStatus(prefsStatusEl, e.message, "prefs-error");
    return;
  }
  const p = data.preferences;
  state.prefs = p;
  state.folders = data.folders;
  for (const el of document.querySelectorAll('input[name="reader_mode"]')) el.checked = el.value === p.reader_mode;
  for (const el of document.querySelectorAll('input[name="chat_sort"]')) el.checked = el.value === p.chat_sort;
  for (const el of document.querySelectorAll('input[name="backup_import_mode"]')) el.checked = el.value === p.backup_import_mode;
  $("date-format-select").value = p.date_format;
  $("sync-interval").value = p.sync_interval_minutes;
  $("skip-suffixes").value = (p.skip_chat_suffixes || []).join(", ");
  renderFolders(data.folders, p.excluded_backup_folders || []);
  renderStats(data.status);
}

$("prefs-save").addEventListener("click", async () => {
  const known = new Set(state.folders.map((f) => f.name));
  // Folders unticked here, plus earlier exclusions of folders that no longer exist.
  const unticked = Array.from(document.querySelectorAll(".folder-cb")).filter((c) => !c.checked).map((c) => c.value);
  const keptOld = ((state.prefs && state.prefs.excluded_backup_folders) || []).filter((n) => !known.has(n));
  const update = {
    reader_mode: document.querySelector('input[name="reader_mode"]:checked')?.value,
    chat_sort: document.querySelector('input[name="chat_sort"]:checked')?.value,
    backup_import_mode: document.querySelector('input[name="backup_import_mode"]:checked')?.value,
    excluded_backup_folders: [...unticked, ...keptOld],
    sync_interval_minutes: Number($("sync-interval").value),
    skip_chat_suffixes: $("skip-suffixes").value.split(",").map((s) => s.trim()).filter(Boolean),
    date_format: $("date-format-select").value,
  };
  const btn = $("prefs-save");
  btn.disabled = true;
  setStatus(prefsStatusEl, "Saving…");
  try {
    const res = await api("/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    const modeChanged = res.preferences.reader_mode !== state.readerMode;
    state.prefs = res.preferences;
    state.dateFormat = res.preferences.date_format;
    state.readerMode = res.preferences.reader_mode;
    state.chatSort = res.preferences.chat_sort;
    setStatus(prefsStatusEl, "Saved and applied.", "prefs-success");
    await loadChats();
    if (state.activeChat) {
      const still = state.chats.find((c) => c.id === state.activeChat.id);
      if (still) await openChat(still);
      else if (modeChanged) {
        state.activeChat = null;
        messageListEl.innerHTML = "";
        emptyHintEl.classList.remove("hidden");
        chatTitleEl.textContent = "Select a chat";
        chatSubEl.textContent = "";
        chatAvatarEl.innerHTML = "";
        appEl.classList.remove("chat-active");
      }
    }
  } catch (e) {
    setStatus(prefsStatusEl, e.message, "prefs-error");
  } finally {
    btn.disabled = false;
  }
});

for (const btn of document.querySelectorAll(".action-btn")) {
  btn.addEventListener("click", async () => {
    if (btn.dataset.action === "full-sync" && !confirm("Re-read the whole history of every chat from WAHA? This can take a while.")) return;
    setStatus(actionStatusEl, "Starting…");
    try {
      const res = await api(`/actions/${btn.dataset.action}`, { method: "POST" });
      setStatus(actionStatusEl, `Started: ${res.started}. Progress shows in the status list below.`, "prefs-success");
      setTimeout(refreshStats, 1000);
    } catch (e) {
      setStatus(actionStatusEl, e.message, "prefs-error");
    }
  });
}

// ------------------------------------------------------------------ start

async function init() {
  try {
    const data = await api("/preferences");
    state.prefs = data.preferences;
    state.dateFormat = data.preferences.date_format || "dmy_12h";
    state.readerMode = data.preferences.reader_mode || "ios";
    state.chatSort = data.preferences.chat_sort || "latest";
    if (data.logout_url) {
      const a = $("logout-link");
      a.href = data.logout_url;
      a.classList.remove("hidden");
    }
  } catch (e) {
    // defaults are already set
  }
  try {
    await loadChats();
  } catch (e) {
    chatListEl.textContent = e.message;
  }
}

// Pick up newly archived messages when the tab is shown again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadChats().catch(() => {});
});

init();
