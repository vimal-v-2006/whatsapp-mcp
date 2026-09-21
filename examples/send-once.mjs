/**
 * Headless automation example — works without any agent harness.
 * The session is persisted, so after the first QR pairing this runs unattended
 * (cron, systemd timer, CI, whatever).
 *
 *   node examples/send-once.mjs
 */
import * as wa from "../core/api.mjs";

// 1) wait until linked (a QR is printed to the terminal on first run).
//    If another process (pi/hermes) already owns the session, this just joins it.
{
  const t0 = Date.now();
  for (;;) {
    const st = await wa.status();
    if (st.state === "online") break;
    if (Date.now() - t0 > 120_000) throw new Error("timed out waiting for the device to link — scan the QR shown in the terminal");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// 2) do the automation
const res = await wa.sendMessage("+14155551234", "✅ Deploy finished: v1.42 → production");
console.log("sent:", res);

// 3) read something back
const chats = await wa.listChats({ limit: 10 });
console.log("recent chats:", chats.chats.map((c) => c.name || c.id).join(", "));

process.exit(0);
