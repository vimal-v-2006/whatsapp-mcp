/**
 * Public API facade — import THIS from entry points (MCP server, pi
 * extension, scripts), not core/whatsapp.mjs directly.
 *
 * Every call first runs session election (core/daemon.mjs): if another
 * process already owns the WhatsApp connection, this process forwards the
 * call over the local bridge; otherwise this process owns the session and
 * calls the core locally. Callers don't need to know the difference.
 */
import * as core from "./whatsapp.mjs";
import { acquire, role_, callTool, TOOLS, shutdown } from "./daemon.mjs";

async function call(name, ...args) {
  await acquire();
  if (role_() === "client") return callTool(name, args);
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(...args);
}

export const DATA_DIR = core.DATA_DIR;
export const QR_FILE = core.QR_FILE;
export { acquire, shutdown, role_ as role };

export const status = () => call("whatsapp_status");
export const link = (a) => call("whatsapp_link", a ?? {});
export const unlink = () => call("whatsapp_unlink");
export const pairingCode = (phone) => call("whatsapp_pairing_code", phone);
export const listChats = (a) => call("whatsapp_list_chats", a ?? {});
export const readMessages = (chat, a) => call("whatsapp_read_messages", chat, a ?? {});
export const sendMessage = (to, text) => call("whatsapp_send_message", to, text);
export const sendMedia = (to, filePath, a) => call("whatsapp_send_media", to, filePath, a ?? {});
export const deleteMessage = (chat, messageId, a) => call("whatsapp_delete_message", chat, messageId, a ?? {});
export const listContacts = (a) => call("whatsapp_list_contacts", a ?? {});
export const getContact = (idOrName) => call("whatsapp_get_contact", idOrName);
export const searchMessages = (query, a) => call("whatsapp_search_messages", query, a ?? {});
export const groupInfo = (group) => call("whatsapp_group_info", group);
