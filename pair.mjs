/**
 * Pairing helper — run this in YOUR terminal to (re)pair the phone.
 *
 *   node pair.mjs
 *
 * It prints the QR as it appears (it rotates ~every 20s — always scan the
 * latest one). Keep this terminal open; it exits with ✅ once your phone
 * links. The session is then saved, and from now on the MCP server, pi,
 * hermes and scripts all reconnect silently — and SHARE this one connection
 * over a local bridge (only one process owns the socket at a time).
 */
import * as wa from "./core/api.mjs";

console.log("\nStarting WhatsApp session — this process owns the connection while it runs...\n");

let shownQr = null;
const t0 = Date.now();
for (;;) {
  const st = await wa.status();
  if (st.state === "online") {
    console.log(`\n✅ Linked! Device: ${st.device?.name ?? ""} (${st.device?.jid ?? "?"})`);
    console.log("Session saved. You can close this terminal — pairing is done.");
    process.exit(0);
  }
  if (st.state === "qr_pending" || st.qr) {
    // fetch the current QR (ASCII + PNG path) and print each new one
    try {
      const l = await wa.link();
      const sig = l.qrFile ?? l.qrAscii;
      if (sig && sig !== shownQr) {
        shownQr = sig;
        if (l.qrAscii) console.log("\n" + l.qrAscii);
        if (l.qrFile) console.log(`(QR image: ${l.qrFile})`);
        console.log("Scan with WhatsApp: Settings > Linked devices > Link a device. A new QR prints ~every 20s — scan the newest one.");
      }
    } catch {}
  }
  if (Date.now() - t0 > 10 * 60 * 1000) {
    console.error("\nTimed out after 10 minutes. Run `node pair.mjs` again for a fresh QR.");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
