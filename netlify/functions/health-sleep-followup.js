/**
 * Scheduled 08:00 and 10:00 UTC (09:00 / 11:00 BST): if the 07:30 summary went
 * out before the band had synced last night's sleep, send a one-line
 * "Sleep update" once it has. No-op otherwise. See sendSleepFollowup.
 */
import { sendSleepFollowup } from "../lib/health.js";

export default async () => {
  try {
    const r = await sendSleepFollowup({ via: "netlify-schedule" });
    console.log("health-sleep-followup", JSON.stringify(r));
    return new Response(r.sent ? "sent" : r.reason);
  } catch (e) {
    console.error("health-sleep-followup failed", e);
    return new Response("error", { status: 500 });
  }
};

export const config = { schedule: "0 8,10 * * *" };
