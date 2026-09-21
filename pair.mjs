/**
 * Pairing helper — run this in YOUR terminal to (re)pair the phone.
 *
 *   node pair.mjs
 *
 * It prints the QR as it appears (it rotates ~every 20s — always scan the
 * latest one). Keep this terminal open; it exits with ✅ once your phone
 * links. The session is then saved, and the MCP server / pi / hermes all
 * reconnect silently from now on.
 */
import * as wa from "./core/whatsapp.mjs";

await wa.getSocket();
console.log("\nWaiting for QR — scan it with WhatsApp (Settings > Linked devices > Link a device):\n");

const t0 = Date.now();
for (;;) {
  const st = wa.status();
  if (st.state === "online") {
    console.log(`\n✅ Linked! Device: ${st.device?.name ?? ""} (${st.device?.jid ?? "?"})`);
    console.log("Session saved. You can close this terminal — pairing is done.");
    process.exit(0);
  }
  if (Date.now() - t0 > 10 * 60 * 1000) {
    console.error("\nTimed out after 10 minutes. Run `node pair.mjs` again for a fresh QR.");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
