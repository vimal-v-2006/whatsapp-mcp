#!/usr/bin/env node
/**
 * whatsapp-mcp — MCP (stdio) server exposing WhatsApp read/write tools.
 *
 * Works with any MCP-capable agent harness (Claude Code, Cursor, hermes, etc.).
 * The WhatsApp session starts in the background on boot:
 *  - if a saved session exists it reconnects silently,
 *  - otherwise a QR code is printed to stderr (and saved to ~/.whatsapp-mcp/qr.png).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as wa from "./core/api.mjs";

const server = new McpServer({ name: "whatsapp", version: "1.0.0" });

// start the WhatsApp session in the background immediately
// Elect/claim the WhatsApp session (becomes owner, or joins an existing owner).
wa.status().catch(() => {});
process.on("SIGINT", () => wa.shutdown());
process.on("SIGTERM", () => wa.shutdown());

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args || {}));
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e?.message || String(e)}` }], isError: true };
    }
  };
}

const define = typeof server.registerTool === "function"
  ? (name, meta, handler) => server.registerTool(name, meta, handler)
  : (name, meta, handler) => server.tool(name, meta, handler);

define("whatsapp_status", {
  title: "WhatsApp status",
  description: "Check the WhatsApp device link state (online / QR pending / not started) and which device is linked.",
  inputSchema: {},
}, wrap(() => wa.status()));

define("whatsapp_link", {
  title: "WhatsApp link device",
  description:
    "Get the QR code to pair a phone (WhatsApp > Settings > Linked devices > Link a device). Returns the QR as ASCII and as a PNG file path. You only scan once; the session persists.",
  inputSchema: {},
}, wrap(() => wa.link()));

define("whatsapp_unlink", {
  title: "WhatsApp unlink device",
  description: "Unlink the device, wipe the local session and start a fresh pairing (a new QR will be generated).",
  inputSchema: {},
}, wrap(() => wa.unlink()));

define("whatsapp_pairing_code", {
  title: "WhatsApp pairing code",
  description:
    "Alternative to QR: get an 8-character pairing code for a phone number (used in WhatsApp > Linked devices > Link with phone number).",
  inputSchema: { phone_number: z.string().describe("Phone number with country code, e.g. +14155551234") },
}, wrap((a) => wa.pairingCode(a.phone_number)));

define("whatsapp_list_chats", {
  title: "List WhatsApp chats",
  description: "List recent conversations (DMs and groups) with name, unread count and last message preview.",
  inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Max chats to return (default 50)") },
}, wrap((a) => wa.listChats(a)));

define("whatsapp_read_messages", {
  title: "Read WhatsApp messages",
  description: "Read messages from a chat, optionally within a date range. `chat` accepts a JID (123@s.whatsapp.net), a phone number (+123...) or a contact/chat name. History is fetched on demand — nothing is bulk-downloaded.",
  inputSchema: {
    chat: z.string().describe("Chat JID, phone number, or contact/group name"),
    limit: z.number().int().min(1).max(200).optional().describe("Max messages to return (default 20)"),
    since: z.string().optional().describe("Only messages at/after this date, e.g. '2025-09-21' or '2025-09-21T18:00:00Z' (or epoch seconds)"),
    until: z.string().optional().describe("Only messages at/before this date (same formats as `since`)"),
  },
}, wrap((a) => wa.readMessages(a.chat, { limit: a.limit ?? 20, since: a.since, until: a.until })));


define("whatsapp_send_message", {
  title: "Send WhatsApp message",
  description: "Send a text message. `to` accepts a JID, phone number (+CC...) or a contact/chat name.",
  inputSchema: {
    to: z.string().describe("Recipient JID, phone number, or contact/chat name"),
    text: z.string().describe("Message text"),
  },
}, wrap((a) => wa.sendMessage(a.to, a.text)));

define("whatsapp_send_media", {
  title: "Send WhatsApp media",
  description: "Send a file (image/video/audio/document/sticker) from a local path.",
  inputSchema: {
    to: z.string().describe("Recipient JID, phone number, or contact/chat name"),
    path: z.string().describe("Absolute or relative path to the file on this machine"),
    caption: z.string().optional().describe("Caption (images, videos, documents)"),
    type: z.enum(["auto", "image", "video", "audio", "document", "sticker"]).optional().describe("Override file type detection (default auto)"),
  },
}, wrap((a) => wa.sendMedia(a.to, a.path, { caption: a.caption ?? "", type: a.type ?? "auto" })));

define("whatsapp_delete_message", {
  title: "Delete WhatsApp message",
  description: "Delete (revoke) a message in a chat. Use the message `id` from whatsapp_read_messages.",
  inputSchema: {
    chat: z.string().describe("Chat JID or name"),
    message_id: z.string().describe("Message id from whatsapp_read_messages"),
    from_me: z.boolean().optional().describe("true if you sent the message (default true)"),
  },
}, wrap((a) => wa.deleteMessage(a.chat, a.message_id, { fromMe: a.from_me ?? true })));

define("whatsapp_list_contacts", {
  title: "List WhatsApp contacts",
  description: "List known contacts (from synced history) with JID and name.",
  inputSchema: { limit: z.number().int().min(1).max(500).optional().describe("Max contacts to return (default 100)") },
}, wrap((a) => wa.listContacts(a)));

define("whatsapp_get_contact", {
  title: "Get WhatsApp contact",
  description: "Resolve a contact by JID, phone number or name; returns existence, LID and profile picture URL.",
  inputSchema: { id_or_name: z.string().describe("Contact JID, phone number, or name") },
}, wrap((a) => wa.getContact(a.id_or_name)));

define("whatsapp_search_messages", {
  title: "Search WhatsApp messages",
  description: "Full-text search across recent chats, scoped to a time window (default last 2 days). History is fetched on demand.",
  inputSchema: {
    query: z.string().describe("Text to search for"),
    limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
    days: z.number().int().min(1).max(30).optional().describe("Search only the last N days (default 2)"),
    max_chats: z.number().int().min(1).max(200).optional().describe("Max chats to scan (default 100)"),
  },
}, wrap((a) => wa.searchMessages(a.query, { limit: a.limit ?? 20, days: a.days ?? 2, maxChats: a.max_chats ?? 100 })));

define("whatsapp_group_info", {
  title: "WhatsApp group info",
  description: "Get group subject, description, size and participant list.",
  inputSchema: { group: z.string().describe("Group JID or group name") },
}, wrap((a) => wa.groupInfo(a.group)));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[whatsapp-mcp] MCP server ready on stdio\n");
