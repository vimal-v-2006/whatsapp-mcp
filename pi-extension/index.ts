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
// @ts-ignore - plain ESM core module (resolved relative to this file)
import * as wa from "../core/whatsapp.mjs";

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
    description: "Read the latest messages from a chat (JID, phone number, or contact/group name).",
    parameters: Type.Object({
      chat: Type.String({ description: "chat JID, phone number, or name" }),
      limit: Type.Optional(Type.Number({ description: "max messages (default 20)" })),
    }),
    run: (a) => wa.readMessages(a.chat, { limit: a.limit ?? 20 }),
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
    description: "Full-text search across locally synced chat history.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ description: "max results (default 20)" })),
      max_chats: Type.Optional(Type.Number({ description: "max chats to scan (default 50)" })),
    }),
    run: (a) => wa.searchMessages(a.query, { limit: a.limit ?? 20, maxChats: a.max_chats ?? 50 }),
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
  // start the WhatsApp session in the background at extension load
  (wa as any).getSocket().catch(() => {});

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
