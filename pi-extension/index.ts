/**
 * whatsapp extension for pi (native tools — pi has no MCP by design).
 *
 * Usage:
 *   pi -e /path/to/whatsapp-mcp/pi-extension/index.ts
 * or add to pi settings.json:
 *   { "extensions": ["/path/to/whatsapp-mcp/pi-extension"] }
 *
 * The WhatsApp session starts in the background. First run prints a QR code
 * to the terminal (and saves ~/.whatsapp-mcp/qr.png) — scan it once with your
 * phone (Settings > Linked devices > Link a device).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// @ts-ignore - plain ESM API facade (routes to the session owner over a local bridge if needed)
import * as wa from "../core/api.mjs";

interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: any;
  run: (args: any) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "whatsapp_status",
    label: "WhatsApp Status",
    description: "Check the WhatsApp device link state (online / QR pending / not started).",
    parameters: Type.Object({}),
    run: () => wa.status(),
  },
  {
    name: "whatsapp_link",
    label: "WhatsApp Link",
    description:
      "Get the QR code to pair a phone (WhatsApp > Settings > Linked devices > Link a device). Returns QR ASCII + PNG path. Scan once; session persists.",
    parameters: Type.Object({}),
    run: () => wa.link(),
  },
  {
    name: "whatsapp_unlink",
    label: "WhatsApp Unlink",
    description: "Unlink the device, wipe the local session and start fresh pairing.",
    parameters: Type.Object({}),
    run: () => wa.unlink(),
  },
  {
    name: "whatsapp_pairing_code",
    label: "WhatsApp Pairing Code",
    description: "Alternative to QR: 8-char pairing code for a phone number.",
    parameters: Type.Object({ phone_number: Type.String({ description: "e.g. +14155551234" }) }),
    run: (a) => wa.pairingCode(a.phone_number),
  },
  {
    name: "whatsapp_list_chats",
    label: "WhatsApp List Chats",
    description: "List recent conversations with name, unread count and last message preview.",
    parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "max chats (default 50)" })) }),
    run: (a) => wa.listChats(a),
  },
  {
    name: "whatsapp_read_messages",
    label: "WhatsApp Read Messages",
    description: "Read messages from a chat (JID, phone number, or name), optionally within a date range (since/until, e.g. '2025-09-21'). History is fetched on demand.",
    parameters: Type.Object({
      chat: Type.String({ description: "chat JID, phone number, or name" }),
      limit: Type.Optional(Type.Number({ description: "max messages (default 20, max 200)" })),
      since: Type.Optional(Type.String({ description: "only messages at/after this date, e.g. '2025-09-21' or ISO/epoch seconds" })),
      until: Type.Optional(Type.String({ description: "only messages at/before this date (same formats as since)" })),
    }),
    run: (a) => wa.readMessages(a.chat, { limit: a.limit ?? 20, since: a.since, until: a.until }),
  },
  {
    name: "whatsapp_send_message",
    label: "WhatsApp Send Message",
    description: "Send a text message to a JID, phone number, or contact/chat name.",
    parameters: Type.Object({
      to: Type.String({ description: "recipient JID, phone number, or name" }),
      text: Type.String({ description: "message text" }),
    }),
    run: (a) => wa.sendMessage(a.to, a.text),
  },
  {
    name: "whatsapp_send_media",
    label: "WhatsApp Send Media",
    description: "Send a file (image/video/audio/document/sticker) from a local path.",
    parameters: Type.Object({
      to: Type.String({ description: "recipient JID, phone number, or name" }),
      path: Type.String({ description: "path to the file" }),
      caption: Type.Optional(Type.String()),
      type: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("image"), Type.Literal("video"), Type.Literal("audio"), Type.Literal("document"), Type.Literal("sticker")])),
    }),
    run: (a) => wa.sendMedia(a.to, a.path, { caption: a.caption ?? "", type: a.type ?? "auto" }),
  },
  {
    name: "whatsapp_delete_message",
    label: "WhatsApp Delete Message",
    description: "Delete (revoke) a message. Use the id from whatsapp_read_messages.",
    parameters: Type.Object({
      chat: Type.String({ description: "chat JID or name" }),
      message_id: Type.String({ description: "message id" }),
      from_me: Type.Optional(Type.Boolean({ description: "default true" })),
    }),
    run: (a) => wa.deleteMessage(a.chat, a.message_id, { fromMe: a.from_me ?? true }),
  },
  {
    name: "whatsapp_list_contacts",
    label: "WhatsApp List Contacts",
    description: "List known contacts with JID and name.",
    parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "max contacts (default 100)" })) }),
    run: (a) => wa.listContacts(a),
  },
  {
    name: "whatsapp_get_contact",
    label: "WhatsApp Get Contact",
    description: "Resolve a contact by JID, phone number or name (existence, LID, profile picture).",
    parameters: Type.Object({ id_or_name: Type.String() }),
    run: (a) => wa.getContact(a.id_or_name),
  },
  {
    name: "whatsapp_search_messages",
    label: "WhatsApp Search Messages",
    description: "Full-text search across recent chats, scoped to a time window (default last 2 days). History is fetched on demand.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ description: "max results (default 20)" })),
      days: Type.Optional(Type.Number({ description: "search only the last N days (default 2, max 30)" })),
      max_chats: Type.Optional(Type.Number({ description: "max chats to scan (default 100)" })),
    }),
    run: (a) => wa.searchMessages(a.query, { limit: a.limit ?? 20, days: a.days ?? 2, maxChats: a.max_chats ?? 100 }),
  },
  {
    name: "whatsapp_group_info",
    label: "WhatsApp Group Info",
    description: "Group subject, description, size and participants.",
    parameters: Type.Object({ group: Type.String({ description: "group JID or name" }) }),
    run: (a) => wa.groupInfo(a.group),
  },
];

export default function (pi: ExtensionAPI) {
  // claim (or join) the WhatsApp session in the background at extension load.
  // Ownership lives with the process: when pi exits, the lock goes stale and
  // the next client (hermes, a script, another pi) picks the session back up.
  wa.status().catch(() => {});

  for (const t of TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: t.parameters,
      async execute(_toolCallId, params) {
        try {
          const result = await t.run((params ?? {}) as any);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { ok: true } };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Error: ${e?.message ?? String(e)}` }], details: { ok: false } };
        }
      },
    });
  }
}
