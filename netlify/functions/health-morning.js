/**
 * Scheduled: every day at 06:30 UTC (07:30 BST / 06:30 GMT).
 * Sends last night's sleep + yesterday's activity to Matt on Telegram,
 * flagging anything off his 7-day baseline.
 *
 * Skips sending if there is no data at all (e.g. phone hasn't synced), and
 * says so instead — silence would be indistinguishable from a broken pipeline.
 */
import { morningMessage, sendTelegram, store } from "../lib/health.js";

export default async () => {
  try {
    const m = await morningMessage();
    const meta = await store().get("meta/last-ingest", { type: "json" });
    const hasData = m.today.sleep || m.yesterday.steps != null || m.yesterday.rhr != null;
    if (!hasData) {
      const last = meta?.at ? `last sync ${meta.at.replace("T", " ").slice(0, 16)} UTC` : "no sync received yet";
      await sendTelegram(`Health: no data for today or yesterday (${last}). Check Health Webhook on your phone.`);
      return new Response("no data");
    }
    await sendTelegram(m.text);
    return new Response("sent");
  } catch (e) {
    console.error("health-morning failed", e);
    try { await sendTelegram(`Health summary failed: ${e.message}`); } catch {}
    return new Response("error", { status: 500 });
  }
};

export const config = { schedule: "30 6 * * *" };
