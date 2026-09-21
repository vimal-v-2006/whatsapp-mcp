/**
 * Smoke test: connects to the MCP server over stdio, lists tools,
 * checks status and requests the link QR. Run: npm test
 * (QR is printed to the terminal by the server — scan it if you want to pair now)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./server.mjs", import.meta.url).pathname],
  stderr: "inherit",
});

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const names = (tools.tools || tools).map((t) => t.name);
console.error(`\n[smoke] ${names.length} tools: ${names.join(", ")}\n`);

const status = await client.callTool({ name: "whatsapp_status", arguments: {} });
console.error("[smoke] status:\n" + status.content?.[0]?.text + "\n");

const link = await client.callTool({ name: "whatsapp_link", arguments: {} });
const linkText = link.content?.[0]?.text || "";
console.error("[smoke] link (truncated):\n" + linkText.slice(0, 900) + "\n");

await client.close();
console.log("SMOKE OK");
process.exit(0);
