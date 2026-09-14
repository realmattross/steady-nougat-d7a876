/**
 * GET /health/report?date=YYYY-MM-DD   -> that day's aggregated stats (default today)
 * GET /health/report?days=7            -> last N days of stats
 * GET /health/report?morning=1         -> the morning summary text + data (no send)
 * GET /health/report?morning=1&send=1  -> generate AND send to Telegram
 * GET /health/report?status=1          -> last-ingest metadata
 *
 * Auth: Bearer $HEALTH_INGEST_TOKEN (or ?token=)
 * Used by Jeeves (Mac) to answer "how did I sleep?" and for manual testing.
 */
import { authed, dayStats, todayLocal, shiftDate, morningMessage, sendTelegram, store } from "../lib/health.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });
  const q = new URL(req.url).searchParams;

  try {
    if (q.get("status")) {
      const meta = await store().get("meta/last-ingest", { type: "json" });
      return json({ lastIngest: meta || null, today: todayLocal() });
    }
    if (q.get("morning")) {
      const m = await morningMessage(q.get("date") || todayLocal());
      if (q.get("send")) await sendTelegram(m.text);
      return json({ sent: !!q.get("send"), ...m });
    }
    const days = Number(q.get("days") || 0);
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
