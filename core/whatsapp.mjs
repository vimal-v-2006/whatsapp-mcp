/**
 * WhatsApp session core (Baileys) — shared by the MCP server and the pi extension.
 *
 * - Links the phone once via QR code (session persisted in DATA_DIR).
 * - Keeps an in-memory chat/contact/message store.
 * - Exposes plain async functions used as tools by any harness.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import pino from "pino";

export const DATA_DIR = process.env.WHATSAPP_MCP_DATA_DIR
  ? path.resolve(process.env.WHATSAPP_MCP_DATA_DIR)
  : path.join(os.homedir(), ".whatsapp-mcp");
export const QR_FILE = path.join(DATA_DIR, "qr.png");

const logger = pino({ level: "silent" });
const store = makeInMemoryStore({ logger });

/** @type {ReturnType<typeof makeWASocket> | null} */
let sock = null;
let starting = null;
let restartTimer = null;
let lastQrEmitted = null;
let online = false;
let seenFirstUpdate = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  try {
    process.stderr.write([...args].join(" ") + "\n");
  } catch {}
}

function renderQr(qr) {
  if (!qr || qr === lastQrEmitted) return;
  lastQrEmitted = qr;
  QRCode.toFile(QR_FILE, qr, { width: 320, margin: 2, errorCorrectionLevel: "M" }).catch(() => {});
  QRCode.toString(qr, { small: true })
    .then((ascii) => {
      log("");
      log("=== WhatsApp pairing: open WhatsApp > Settings > Linked devices > Link a device ===");
      log(ascii);
      log(`QR image also saved to: ${QR_FILE}`);
      log("");
    })
    .catch(() => {});
}

async function startSocket() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);
  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch {
    /* offline: use baileys default */
  }

  sock = makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    store,
    browser: ["WhatsApp MCP", "Chrome", "131.0.0.0"],
    version,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,
    defaultQueryTimeoutMs: 20000,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    seenFirstUpdate = true;
    if (update.qr) renderQr(update.qr);
    if (update.connection === "open") {
      online = true;
      lastQrEmitted = null;
      try {
        fs.unlinkSync(QR_FILE);
      } catch {}
      log(`[whatsapp-mcp] connected as ${sock.user?.id ?? "unknown"}`);
    } else if (update.connection === "close") {
      online = false;
      const reason = update.closeReason;
      const code = Number(reason);
      log(`[whatsapp-mcp] connection closed (code=${code})`);
      const loggedOut = code === DisconnectReason.loggedOut;
      const restartable =
        loggedOut ||
        code === DisconnectReason.restartRequired ||
        code === DisconnectReason.connectionClosed ||
        code === DisconnectReason.timedOut ||
        code === DisconnectReason.multipeer;
      if (restartable) scheduleRestart(loggedOut);
    }
  });
  store.bind(sock.ev);
  return sock;
}

function scheduleRestart(wipeCreds = false) {
  if (restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (wipeCreds) fs.rmSync(DATA_DIR, { recursive: true, force: true });
    try {
      sock?.ev?.destroy?.();
    } catch {}
    try {
      await sock?.end?.(undefined);
    } catch {}
    sock = null;
    starting = startSocket().catch((e) => log("[whatsapp-mcp] restart failed:", e?.message)).finally(() => {
      starting = null;
    });
  }, wipeCreds ? 3000 : 2000);
  restartTimer.unref?.();
}

/**
 * Get (and lazily start) the socket.
 * @param {{ wait?: boolean, timeoutMs?: number }} opts wait=true blocks until the device is linked/online
 */
export async function getSocket({ wait = false, timeoutMs = 30000 } = {}) {
  if (!sock || !["open", "connecting", "close"].includes(store.state.connection)) {
    if (!starting) starting = startSocket().finally(() => { starting = null; });
    await starting;
  }
  if (wait && !online) {
    const t0 = Date.now();
    while (!online && Date.now() - t0 < timeoutMs) await sleep(250);
    if (!online) {
      const st = store.state;
      if (st.connection === "close" && Number(st.closeReason) !== DisconnectReason.loggedOut) {
        scheduleRestart(false);
        throw new Error("Connection is not established. Restarting — retry in a few seconds.");
      }
      throw new Error(
        st.qr
          ? "Device is not linked yet. Scan the QR (see whatsapp_link) and retry."
          : "Not connected yet. Run whatsapp_link / check the terminal for a QR code."
      );
    }
  }
  return sock;
}

/* ---------------- status / linking ---------------- */

export function status() {
  const st = store.state;
  const rawState = !sock
    ? starting
      ? "starting"
      : "not_started"
    : online
      ? "online"
      : st.qr
        ? "qr_pending"
        : seenFirstUpdate
          ? "closed"
          : "connecting";
  return {
    state: rawState,
    qrPending: !!st.qr,
    device: sock?.user
      ? { jid: sock.user.id, name: sock.user.name || null, lid: sock.user.idL || null }
      : null,
    dataDir: DATA_DIR,
    qrFile: st.qr ? QR_FILE : null,
    hint: online
      ? "Device linked and online. All read/write tools are ready."
      : st.qr
        ? "Scan the QR (whatsapp_link) with your phone to pair. You only do this once."
        : "Session starting — call whatsapp_link to get the QR code.",
  };
}

export async function link({ timeoutMs = 45000 } = {}) {
  await getSocket();
  const t0 = Date.now();
  while (!online && !store.state.qr && Date.now() - t0 < 10000) await sleep(200);
  if (online) {
    return { ok: true, state: "online", note: "Already linked and online.", device: { jid: sock.user?.id, name: sock.user?.name } };
  }
  const qr = store.state.qr;
  const ascii = qr ? await QRCode.toString(qr, { small: true }).catch(() => null) : null;
  return {
    ok: !!qr,
    state: store.state.connection || "connecting",
    qrFile: qr ? QR_FILE : null,
    qrAscii: ascii,
    note: qr
      ? "Scan the QR above with WhatsApp on your phone (Settings > Linked devices > Link a device), or open the PNG. The session persists — you scan only once."
      : "Waiting for a QR code... check the terminal; the server prints it automatically.",
  };
}

export async function unlink() {
  if (sock) {
    try {
      await sock.logout();
    } catch {}
    try {
      sock.end?.(undefined);
    } catch {}
  }
  sock = null;
  online = false;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  lastQrEmitted = null;
  starting = startSocket().catch((e) => log("[whatsapp-mcp] restart failed:", e?.message)).finally(() => {
    starting = null;
  });
  await starting;
  return { ok: true, note: "Device unlinked and session cleared. Call whatsapp_link to get a fresh QR code." };
}

/** Optional: pair with an 8-char code instead of a QR (WhatsApp can't show QR on some setups). */
export async function pairingCode(phoneNumber) {
  const s = await getSocket({ wait: true });
  const code = await s.requestPairingCode(String(phoneNumber).replace(/[^\d]/g, ""));
  return { ok: true, phoneNumber, pairingCode: code, note: "Enter this code on the phone: Settings > Linked devices > Link a device > Link with phone number." };
}

/* ---------------- identifiers & message shaping ---------------- */

function resolveJid(input) {
  const t = String(input ?? "").trim();
  if (!t) throw new Error("Empty chat/contact identifier.");
  if (t.includes("@")) return t;
  if (/^\+?\d{5,20}$/.test(t)) return t.replace("+", "") + "@s.whatsapp.net";
  const list = Object.values(store.contacts || {});
  const exact = list.find((c) => (c.name || c.notify) === t);
  if (exact) return exact.id;
  const ci = list.find((c) => (c.name || c.notify)?.toLowerCase() === t.toLowerCase());
  if (ci) return ci.id;
  for (const c of store.chats.map()) {
    if (c.name?.toLowerCase() === t.toLowerCase()) return c.id;
  }
  throw new Error(
    `Could not resolve "${t}". Use a full JID (e.g. 1234567890@s.whatsapp.net), a phone number (e.g. +1234567890), or a name from whatsapp_list_contacts.`
  );
}

function tsOf(m) {
  const t = m.messageTimestamp;
  if (t == null) return null;
  const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  return isNaN(ms) ? null : new Date(ms).toISOString();
}

function describeMessage(m) {
  const p = m.message || {};
  const media = (() => {
    if (p.imageMessage) return { kind: "image", caption: p.imageMessage.caption || null };
    if (p.videoMessage) return { kind: "video", caption: p.videoMessage.caption || null, seconds: p.videoMessage.seconds ?? null };
    if (p.audioMessage) return { kind: "audio", seconds: p.audioMessage.seconds ?? null, ptt: !!p.audioMessage.ptt };
    if (p.documentMessage) return { kind: "document", fileName: p.documentMessage.fileName || "document" };
    if (p.stickerMessage) return { kind: "sticker" };
    if (p.locationMessage) return { kind: "location", latitude: p.locationMessage.degreesLatitude, longitude: p.locationMessage.degreesLongitude };
    if (p.contactMessage) return { kind: "contact", displayName: p.contactMessage.displayName };
    if (p.listMessage) return { kind: "list", title: p.listMessage.title, description: p.listMessage.description };
    if (p.buttonsMessage) return { kind: "buttons", text: p.buttonsMessage.text };
    if (p.orderMessage) return { kind: "order", itemCount: p.orderMessage.orderMessageId ? undefined : undefined };
    return null;
  })();
  const text =
    p.conversation ??
    p.extendedTextMessage?.text ??
    p.listMessage?.description ??
    p.buttonsMessage?.text ??
    p.imageMessage?.caption ??
    p.videoMessage?.caption ??
    null;
  return {
    id: m.key?.id || null,
    fromMe: !!m.key?.fromMe,
    participant: m.key?.participant || null,
    sender: m.pushName || null,
    timestamp: tsOf(m),
    type: p.conversation || p.extendedTextMessage ? "text" : media?.kind ?? "other",
    text: text || null,
    ...(media && media.kind !== "sticker" ? { media: media } : {}),
  };
}

/* ---------------- read tools ---------------- */

export async function listChats({ limit = 50 } = {}) {
  await getSocket({ wait: true });
  let chats = store.chats.map();
  if (Array.isArray(chats)) {
    chats = chats.sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0));
  }
  chats = chats.slice(0, Number(limit) || 50);
  let bots = [];
  try {
    bots = (await sock.getBotListV2()) || [];
  } catch {}
  const botById = Object.fromEntries(bots.map((b) => [b.jid, b]));
  return {
    count: chats.length,
    chats: chats.map((c) => {
      const b = botById[c.id];
      const msgs = c.messages?.length ? c.messages : [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      return {
        id: c.id,
        name: c.name || b?.chatName || last?.pushName || null,
        isGroup: !!c.isGroup,
        unread: c.unreadCount ?? b?.unreadCount ?? 0,
        lastMessageAt: last ? tsOf(last) : b?.conversationTimestamp ? new Date(b.conversationTimestamp * 1000).toISOString() : null,
        lastMessage: last ? describeMessage(last) : b?.lastMessage ? describeMessage(b.lastMessage) : null,
      };
    }),
  };
}

export async function readMessages(chat, { limit = 20 } = {}) {
  const s = await getSocket({ wait: true });
  const jid = resolveJid(chat);
  let msgs;
  try {
    msgs = await store.loadMessages(jid, Math.min(Number(limit) || 20, 100), {});
  } catch (e) {
    throw new Error(`Could not load messages for ${jid}: ${e?.message || e}`);
  }
  const arr = Array.isArray(msgs) ? msgs : [...msgs];
  return { chat: jid, count: arr.length, messages: arr.map(describeMessage) };
}

export async function searchMessages(query, { limit = 20, maxChats = 50 } = {}) {
  await getSocket({ wait: true });
  const q = String(query).toLowerCase();
  const chats = store.chats.map().slice(0, Number(maxChats) || 50);
  const results = [];
  for (const c of chats) {
    for (const m of c.messages?.array ?? c.messages ?? []) {
      const d = describeMessage(m);
      const hay = [d.text, d.sender, c.name, d.media?.fileName, d.media?.caption].filter(Boolean).join(" ").toLowerCase();
      if (hay.includes(q)) {
        results.push({ chat: c.id, chatName: c.name || null, ...d });
        if (results.length >= (Number(limit) || 20)) return { query, count: results.length, results };
      }
    }
  }
  return {
    query,
    count: results.length,
    results,
    note: "Searches messages in the locally synced history (recent chats). Use whatsapp_read_messages for a specific chat.",
  };
}

/* ---------------- write tools ---------------- */

export async function sendMessage(chat, text) {
  const s = await getSocket({ wait: true });
  const jid = resolveJid(chat);
  const res = await s.sendMessage(jid, { text: String(text ?? "") });
  return {
    ok: true,
    chat: jid,
    messageId: res?.key?.id ?? res?.id ?? null,
    timestamp: res ? tsOf(res) : null,
  };
}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".mkv": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".opus": "audio/ogg", ".wav": "audio/wav", ".pdf": "application/pdf", ".txt": "text/plain",
};

export async function sendMedia(chat, filePath, { caption = "", type = "auto" } = {}) {
  const s = await getSocket({ wait: true });
  const jid = resolveJid(chat);
  const file = path.resolve(String(filePath));
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext] || "application/octet-stream";
  const detected =
    type && type !== "auto"
      ? type
      : ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)
        ? "image"
        : mime.startsWith("video/")
          ? "video"
          : mime.startsWith("audio/")
            ? "audio"
            : "document";
  const payload =
    detected === "image"
      ? { image: buf, caption: caption || undefined }
      : detected === "video"
        ? { video: buf, caption: caption || undefined, gifPlayback: ext === ".gif" }
        : detected === "audio"
          ? { audio: buf, ptt: true }
          : detected === "sticker"
            ? { sticker: buf }
            : { document: buf, fileName: path.basename(file), caption: caption || undefined };
  const res = await s.sendMessage(jid, payload);
  return { ok: true, chat: jid, type: detected, fileName: path.basename(file), messageId: res?.key?.id ?? res?.id ?? null };
}

export async function deleteMessage(chat, messageId, { fromMe = true } = {}) {
  const s = await getSocket({ wait: true });
  const jid = resolveJid(chat);
  const res = await s.sendMessage(jid, {
    protocolMessage: {
      type: "REVOKE",
      key: { id: String(messageId), remoteJid: jid, fromMe: !!fromMe },
    },
  });
  return { ok: true, chat: jid, deleted: messageId, ackId: res?.key?.id ?? null };
}

/* ---------------- contacts & groups ---------------- */

export async function listContacts({ limit = 100 } = {}) {
  await getSocket({ wait: true });
  const contacts = Object.values(store.contacts || {})
    .filter((c) => c.id && !c.id.endsWith("@broadcast"))
    .slice(0, Number(limit) || 100);
  return {
    count: contacts.length,
    contacts: contacts.map((c) => ({
      jid: c.id,
      name: c.name || null,
      pushName: c.notify || null,
      isGroup: c.id.endsWith("@g.us"),
    })),
  };
}

export async function getContact(idOrName) {
  const s = await getSocket({ wait: true });
  const q = String(idOrName ?? "").trim();
  let jid = q.includes("@") ? q : null;
  if (!jid) {
    const list = Object.values(store.contacts || {});
    const hit =
      list.find((c) => (c.name || c.notify) === q) ||
      list.find((c) => (c.name || c.notify)?.toLowerCase() === q.toLowerCase());
    if (hit) jid = hit.id;
  }
  if (!jid && /^\+?\d{5,20}$/.test(q)) jid = q.replace("+", "") + "@s.whatsapp.net";
  if (!jid) throw new Error(`Contact not found: ${idOrName}. Try whatsapp_list_contacts first.`);
  const info = { jid };
  const c = store.contacts?.[jid];
  if (c) info.name = c.name || null;
  if (c) info.pushName = c.notify || null;
  try {
    const wa = await s.onWhatsApp(jid);
    info.exists = (wa || []).some((w) => w.exists);
    info.lid = (wa || []).find((w) => w.lid)?.lid || null;
  } catch {}
  try {
    info.profilePicture = await s.profilePictureUrl(jid, "image");
  } catch {
    info.profilePicture = null;
  }
  return info;
}

export async function groupInfo(group) {
  const s = await getSocket({ wait: true });
  const jid = resolveJid(group);
  const meta = await s.groupMetadata(jid);
  return {
    jid: meta.id,
    subject: meta.subject,
    size: meta.size,
    owner: meta.owner?.user || meta.owner || null,
    description: meta.desc || null,
    createdAt: meta.creation ? new Date(meta.creation * 1000).toISOString() : null,
    participants: (meta.participants || []).map((p) => ({
      jid: p.id,
      admin: p.admin || null,
      pushedName: p.pushname || null,
    })),
  };
}
