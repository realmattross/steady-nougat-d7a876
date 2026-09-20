/**
 * GET /health/report?date=YYYY-MM-DD   -> that day's aggregated stats (default today)
 * GET /health/report?days=7            -> last N days of stats
 * GET /health/report?morning=1         -> the morning summary text + data (no send)
 * GET /health/report?morning=1&send=1  -> send to Telegram if not already sent today (&force=1 to resend)
 * GET /health/report?status=1          -> last-ingest metadata
 * GET /health/report?wipe=YYYY-MM-DD   -> delete that day's stored samples (test cleanup)
 * GET /health/report?raw=1&days=N      -> stored samples for the last N days (for the Mac mirror)
 *
 * Auth: Bearer $HEALTH_INGEST_TOKEN (or ?token=)
 * Used by Jeeves (Mac) to answer "how did I sleep?" and for manual testing.
 */
import { authed, dayStats, todayLocal, shiftDate, morningMessage, sendMorningOnce, store } from "../lib/health.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });
  const q = new URL(req.url).searchParams;

  try {
    if (q.get("wipe")) {
      const date = q.get("wipe");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "wipe=YYYY-MM-DD" }, 400);
      await store().delete(`day/${date}`);
      return json({ wiped: date });
    }
    if (q.get("status")) {
      const meta = await store().get("meta/last-ingest", { type: "json" });
      const log = (await store().get("meta/morning-log", { type: "json" })) || {};
      return json({ lastIngest: meta || null, today: todayLocal(), morningLog: Object.fromEntries(Object.entries(log).sort().slice(-7)) });
    }
    if (q.get("morning")) {
      if (q.get("send")) {
        const r = await sendMorningOnce({ force: !!q.get("force"), via: q.get("via") || "manual" });
        return json(r);
      }
      const m = await morningMessage(q.get("date") || todayLocal());
      return json({ sent: false, ...m });
    }
    const days = Number(q.get("days") || 0);
    if (q.get("raw")) {
      const today = todayLocal();
      const n = Math.min(Math.max(days || 3, 1), 60);
      const out = [];
      for (let i = n - 1; i >= 0; i--) {
        const date = shiftDate(today, -i);
        const rec = await store().get(`day/${date}`, { type: "json" });
        out.push({ date, updated: rec?.updated || null, samples: rec?.samples || {} });
      }
      return json(out);
    }
    if (days > 0) {
      const today = todayLocal();
      const out = [];
      for (let i = days - 1; i >= 0; i--) out.push(await dayStats(shiftDate(today, -i)));
      return json(out);
    }
    return json(await dayStats(q.get("date") || todayLocal()));
  } catch (e) {
    console.error("health-report failed", e);
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/health/report" };
