/**
 * Session ownership + local bridge.
 *
 * A WhatsApp linked device can only hold ONE active connection at a time —
 * if two processes open sockets with the same credentials, WhatsApp kicks
 * them with "stream errored (conflict)" and they ping-pong forever.
 *
 * So exactly one process owns the Baileys socket (the OWNER — whoever calls
 * first), and every other process (a second pi session, hermes, one-shot
 * scripts) transparently becomes a CLIENT that talks to the owner over a
 * loopback-only HTTP endpoint with a bearer token.
 *
 * Election lives in ~/.whatsapp-mcp/daemon.json: { pid, port, token, since }
 *   - live pid + a responsive /status probe  => lock is valid, join as client
 *   - fs.openSync(LOCK, "wx") (O_EXCL)       => prevents two owners at once
 *   - the owner heartbeats the file every 10s; a dead pid means stale lock
 *
 * When the owner exits, the next tool call re-elects: the caller picks the
 * session back up from the persisted credentials and reconnects silently.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import * as core from "./whatsapp.mjs";

const LOCK = path.join(core.DATA_DIR, "daemon.json");
const HEARTBEAT_MS = 10_000;
const CLIENT_TIMEOUT_MS = 120_000;

let role = "undecided"; // "owner" | "client"
let ownerInfo = null;
let server = null;
let heartbeat = null;
let acquiring = null;

function log(...a) {
  try {
    process.stderr.write([...a].join(" ") + "\n");
  } catch {}
}

/** Owner-side dispatch table: tool name -> core function (variadic args). */
export const TOOLS = {
  whatsapp_status: () => core.status(),
  whatsapp_link: (a) => core.link(a ?? {}),
  whatsapp_unlink: () => core.unlink(),
  whatsapp_pairing_code: (phone) => core.pairingCode(phone),
  whatsapp_list_chats: (a) => core.listChats(a ?? {}),
  whatsapp_read_messages: (chat, a) => core.readMessages(chat, a ?? {}),
  whatsapp_send_message: (to, text) => core.sendMessage(to, text),
  whatsapp_send_media: (to, filePath, a) => core.sendMedia(to, filePath, a ?? {}),
  whatsapp_delete_message: (chat, messageId, a) => core.deleteMessage(chat, messageId, a ?? {}),
  whatsapp_list_contacts: (a) => core.listContacts(a ?? {}),
  whatsapp_get_contact: (idOrName) => core.getContact(idOrName),
  whatsapp_search_messages: (query, a) => core.searchMessages(query, a ?? {}),
  whatsapp_group_info: (group) => core.groupInfo(group),
};

function readLock() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (j && j.pid && j.port && j.token) return j;
  } catch {}
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probe(info, ms = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? { ...info, state: body.state } : null;
  } catch {
    return null;
  }
}

async function becomeOwner() {
  const token = crypto.randomBytes(24).toString("hex");
  server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (auth !== token) return send(401, { ok: false, error: "bad token" });
      if (req.method === "GET" && req.url === "/status") {
        const st = core.status();
        return send(200, { ok: true, role: "owner", state: st.state, pid: process.pid });
      }
      if (req.method === "POST" && req.url === "/tool") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { name, args } = JSON.parse(raw || "{}");
        const fn = TOOLS[name];
        if (!fn) return send(400, { ok: false, error: `unknown tool: ${name}` });
        try {
          const result = await fn(...(args || []));
          return send(200, { ok: true, result });
        } catch (e) {
          return send(200, { ok: false, error: e?.message || String(e) });
        }
      }
      send(404, { ok: false, error: "not found" });
    } catch (e) {
      send(500, { ok: false, error: e?.message || String(e) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.mkdirSync(core.DATA_DIR, { recursive: true });
  const fd = fs.openSync(LOCK, "wx", 0o600); // O_EXCL: fail if another owner raced us
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, port, token, since: new Date().toISOString() }, null, 2));
  fs.closeSync(fd);
  role = "owner";
  ownerInfo = { pid: process.pid, port, token };
  heartbeat = setInterval(() => {
    try {
      fs.utimesSync(LOCK, new Date(), new Date());
    } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  log(`[whatsapp-mcp] session OWNER (pid ${process.pid}, port ${port}) — other pi/hermes/script processes share this connection.`);
}

async function becomeClient(info) {
  role = "client";
  ownerInfo = info;
  log(`[whatsapp-mcp] session CLIENT — sharing the connection owned by pid ${info.pid}.`);
}

/**
 * Idempotent: decide (once) whether this process is the session owner or a
 * client of an existing owner. Must be called before any tool call.
 */
export async function acquire() {
  if (role !== "undecided") return role;
  if (!acquiring) {
    acquiring = (async () => {
      const info = readLock();
      if (info && pidAlive(info.pid)) {
        const live = await probe(info);
        if (live) return becomeClient(live);
      }
      try {
        fs.unlinkSync(LOCK); // stale lock (dead pid) — clear it
      } catch {}
      try {
        await becomeOwner();
      } catch {
        // Lost the O_EXCL race: another owner just took the lock. Join it.
        try {
          server?.close();
        } catch {}
        server = null;
        const other = readLock();
        if (other && pidAlive(other.pid)) {
          const live = await probe(other, 4000);
          if (live) return becomeClient(live);
        }
        throw new Error("could not join or own the WhatsApp session — try again");
      }
    })().finally(() => {
      acquiring = null;
    });
  }
  return acquiring;
}

export function role_() {
  return role;
}

export function ownerInfo_() {
  return ownerInfo;
}

async function callTool(name, args, retried = false) {
  if (role !== "client" || !ownerInfo) throw new Error("not a client yet — call acquire() first");
  const { port, token } = ownerInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) throw new Error(body?.error || `daemon error (http ${res.status})`);
    return body.result;
  } catch (e) {
    if (!retried) {
      // Owner may have exited mid-call: re-elect (we may become owner) and retry once.
      role = "undecided";
      ownerInfo = null;
      await acquire();
      if (role === "client") return callTool(name, args, true);
      if (role === "owner") return TOOLS[name](...args);
    }
    throw e;
  }
}

export { callTool };

/** Release ownership / stop the bridge (called on process shutdown, best effort). */
export function shutdown() {
  try {
    if (heartbeat) clearInterval(heartbeat);
  } catch {}
  heartbeat = null;
  try {
    server?.close();
  } catch {}
  server = null;
  if (role === "owner") {
    try {
      fs.unlinkSync(LOCK);
    } catch {}
  }
  role = "undecided";
  ownerInfo = null;
}
