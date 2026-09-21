# whatsapp-mcp 📱

**WhatsApp as an MCP server** — link your phone once by scanning a QR code, then let **any agent** read and write your chats. Works with [pi](#with-pi), [Hermes](#with-hermes), Claude Code, Cursor, or literally any [Model Context Protocol](https://modelcontextprotocol.io) client. Also usable **headless** for plain automation (cron, CI, scripts) with no agent at all.

```
┌──────────────────────────────────────────────────────────────────┐
│  core/whatsapp.mjs — Baileys session + all read/write actions    │
│   • QR pairing (scan once, session persists)                     │
│   • auto-reconnect, auto-restart, QR re-pair on unlink           │
│   • in-memory chat / contact / message store                     │
└───────────────┬──────────────────────────────────┬───────────────┘
                │                                  │
      ┌─────────▼─────────────┐          ┌─────────▼───────────────┐
      │  server.mjs           │          │  pi-extension/index.ts  │
      │  MCP stdio server     │          │  native pi extension    │
      │  → Hermes, Claude     │          │  (pi ships no MCP by    │
      │    Code, Cursor, any  │          │  design — so pi gets    │
      │    MCP client         │          │  the same tools natively)│
      └───────────────────────┘          └─────────────────────────┘
```

---

## Quickstart

```bash
git clone https://github.com/vimal-v-2006/whatsapp-mcp.git
cd whatsapp-mcp
npm install

# boot the server — a QR code prints to your terminal
node server.mjs
```

On your phone: **WhatsApp → Settings → Linked devices → Link a device** → scan the terminal QR (a PNG copy is saved to `~/.whatsapp-mcp/qr.png` if the terminal QR is unreadable).

That's it — you scanned **once**. The session lives in `~/.whatsapp-mcp/`; every future start reconnects silently, even headless.

> **No QR-friendly terminal?** Use a pairing code instead: WhatsApp → Linked devices → *Link with phone number*. The tool `whatsapp_pairing_code` returns an 8-character code.

---

## Tools

| Tool | Description |
|---|---|
| `whatsapp_status` | Link state (`online` / `qr_pending` / `starting` / `closed`), linked device, data dir |
| `whatsapp_link` | Get the pairing QR (ASCII + PNG path). Scan once; session persists |
| `whatsapp_unlink` | Unlink device, wipe local session, generate a fresh QR |
| `whatsapp_pairing_code` | 8-char code pairing instead of QR (phone number input) |
| `whatsapp_list_chats` | Recent DMs/groups: name, unread count, last message preview |
| `whatsapp_read_messages` | Latest N messages of a chat. Accepts JID, phone number, or name |
| `whatsapp_send_message` | Send a text message |
| `whatsapp_send_media` | Send image / video / audio / document / sticker from a local file path |
| `whatsapp_delete_message` | Revoke a message (by id from `whatsapp_read_messages`) |
| `whatsapp_list_contacts` | Known contacts (JID + name) from synced history |
| `whatsapp_get_contact` | Resolve contact by JID/phone/name → existence, LID, profile picture |
| `whatsapp_search_messages` | Full-text search across locally synced chat history |
| `whatsapp_group_info` | Group subject, description, size, participants |

Identifiers are flexible everywhere: `15551234567@s.whatsapp.net` (JID), `+15551234567` (phone), or a contact/group **name** are all accepted by `to` / `chat` / `group` parameters.

**Examples**

```
whatsapp_send_message  { to: "+15551234567", text: "Deploy done ✅" }
whatsapp_read_messages { chat: "Alice", limit: 10 }
whatsapp_send_media    { to: "Team", path: "/tmp/report.pdf", caption: "Q2 numbers" }
whatsapp_search_messages { query: "invoice", limit: 10 }
```

---

## With pi

[pi](https://github.com/badlogic/pi-mono) intentionally ships **no MCP** — so this repo includes a native extension that registers the exact same 13 tools. It lives in `pi-extension/` and reuses the same core.

**Permanent (recommended):** add the directory to your pi settings (`~/.pi/agent/settings.json`):

```json
{
  "extensions": ["/path/to/whatsapp-mcp/pi-extension"]
}
```

**One-off:**

```bash
pi -e /path/to/whatsapp-mcp/pi-extension/index.ts
```

The WhatsApp session starts in the background when pi boots. First run prints the QR to the terminal — scan it, and `whatsapp_*` tools are live in every pi session. (Project-local `.pi/extensions/` also works if you copy the folder in.)

---

## With Hermes

[Hermes](https://github.com/NousResearch) is a first-class MCP client. One command:

```bash
hermes mcp add whatsapp --command node --args /path/to/whatsapp-mcp/server.mjs
```

Hermes connects, discovers the 13 tools, and registers them. Verify any time:

```bash
hermes mcp list          # shows configured servers
hermes mcp test whatsapp # connection + tool discovery check
```

Equivalent raw config (in Hermes's `mcp_servers` section of `config.yaml`):

```yaml
mcp_servers:
  whatsapp:
    command: node
    args: ["/path/to/whatsapp-mcp/server.mjs"]
    # env:            # optional, e.g. custom session dir
    #   WHATSAPP_MCP_DATA_DIR: /home/me/.whatsapp-mcp
```

Per-server extras Hermes supports for this server: `tools.include` / `tools.exclude` filters (e.g. expose only send/read tools to a sub-agent) and `sampling` settings.

> Tip: the WhatsApp session keeps running inside the `hermes mcp`-spawned server process, so pairing state persists across Hermes restarts — scan once, ever.

---

## With Claude Code

```bash
claude mcp add whatsapp -- node /path/to/whatsapp-mcp/server.mjs
```

## With Cursor

Add to `~/.cursor/mcp.json` (or the workspace `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-mcp/server.mjs"]
    }
  }
}
```

## Any other MCP client (generic stdio JSON)

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-mcp/server.mjs"]
    }
  }
}
```

Cline, Continue, Zed, Gemini CLI, OpenCode, Goose… anything that speaks MCP stdio works with this block.

---

## Headless automation (no agent)

The core is a plain ES module — after the first QR pairing you can drive WhatsApp from cron, CI, systemd timers, whatever:

```js
// my-automation.mjs
import * as wa from "/path/to/whatsapp-mcp/core/whatsapp.mjs";

await wa.getSocket({ wait: true });                    // reconnects silently (paired already)
await wa.sendMessage("+15551234567", "Backup finished ✅");

const chats = await wa.listChats({ limit: 10 });
const msgs  = await wa.readMessages(chats.chats[0].id, { limit: 25 });
const hits  = await wa.searchMessages("invoice");
```

**Cron example** — daily 9am digest of yesterday's unread chats:

```cron
0 9 * * * cd /path/to/whatsapp-mcp && node -e '
  import("./core/whatsapp.mjs").then(async wa => {
    await wa.getSocket({ wait: true });
    const { chats } = await wa.listChats({ limit: 20 });
    const lines = chats.filter(c => c.unread > 0)
                       .map(c => `• ${c.name}: ${c.unread} unread`);
    await wa.sendMessage("me@s.whatsapp.net", "Morning digest:\n" + (lines.join("\n") || "no unread"));
  });' >> /tmp/wa-digest.log 2>&1
```

Run `node examples/send-once.mjs` for a working sample script.

---

## How it works

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** (WhatsApp Web multi-device protocol, pinned to `6.5.0` — the last line with the full chat-store API) opens a linked-device session on first run.
- **Pairing:** the QR from `connection.update` is rendered to the terminal (stderr) and to `~/.whatsapp-mcp/qr.png`. Credentials are stored on disk by `useMultiFileAuthState`, so restarts are silent.
- **History:** `syncFullHistory` pulls recent history into an in-memory store on link; `whatsapp_search_messages` / `whatsapp_read_messages` read from it (older history is fetched lazily via the store's `loadMessages`).
- **Resilience:** connection drops auto-restart (2s), logout events wipe creds and re-emit a QR (3s), QR is re-rendered whenever the server rotates it.
- **Protocol hygiene:** only the MCP JSON-RPC goes to stdout; all logs and the QR go to stderr, so MCP clients stay clean.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `WHATSAPP_MCP_DATA_DIR` | `~/.whatsapp-mcp` | Session credentials + `qr.png` location |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No QR appears | Check stderr (MCP clients often hide it — run `node server.mjs` directly). QR only shows when no saved session exists; `whatsapp_unlink` forces one |
| `Device is not linked yet` error from tools | Scan the QR first (`whatsapp_link` returns it) |
| Keeps reconnecting | Unstable network, or the phone itself unlinked the device (battery-saver modes can do this) |
| Logged out / QR after restart | Someone unlinked the device from the phone; just re-scan |
| Messages not searchable | Search covers the locally synced window (recent chats); use `whatsapp_read_messages` on a specific chat for more |
| Update broke things | Baileys is pinned for a reason — don't `npm update` it casually; WhatsApp protocol changes happen fast |

## Security & fair use

- `~/.whatsapp-mcp/` contains **your full WhatsApp session key** — treat it like a password. Don't commit it, don't share it, keep file perms tight (`chmod 700`).
- This uses the **unofficial** WhatsApp Web protocol. It's fine for personal use and moderate automation; aggressive bulk messaging can get your number banned. Be a good citizen: keep volumes human.
- Agents can send messages as you. If you expose tools to a sub-agent, consider Hermes-style `tools.exclude` filters to hide `whatsapp_send_*` from agents that shouldn't write.

## Project layout

```
whatsapp-mcp/
├── core/whatsapp.mjs        # session + actions (shared by both front-ends)
├── server.mjs               # MCP stdio server
├── pi-extension/index.ts    # native pi extension (same 13 tools)
├── examples/send-once.mjs   # headless automation sample
├── test-client.mjs          # npm test — MCP smoke test
└── README.md
```

## License

MIT — do whatever, no warranty. Not affiliated with WhatsApp/Meta.
