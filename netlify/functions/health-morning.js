/**
 * Scheduled: every day at 06:30 UTC (07:30 BST / 06:30 GMT).
 * Sends last night's sleep + yesterday's activity to Matt on Telegram,
 * flagging anything off his 7-day baseline. Idempotent per day: the Mac's
 * hourly job also calls /health/report?morning=1&send=1 at 08:00 UK as a
 * fallback, and whichever runs first wins (see sendMorningOnce).
 */
import { sendMorningOnce, sendTelegram } from "../lib/health.js";

export default async () => {
  try {
    const r = await sendMorningOnce({ via: "netlify-schedule" });
    console.log("health-morning", JSON.stringify(r));
    return new Response(r.already ? "already sent" : "sent");
  } catch (e) {
    console.error("health-morning failed", e);
    try { await sendTelegram(`Health summary failed: ${e.message}`); } catch {}
    return new Response("error", { status: 500 });
  }
};

export const config = { schedule: "30 6 * * *" };
