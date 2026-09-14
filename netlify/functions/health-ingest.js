/**
 * POST /health/ingest
 * Receiver for the Health Webhook iOS app (hcwebhook.com). Also accepts
 * HealthKit-style exports ({ data: { HKQuantityTypeIdentifier…: [...] } }).
 *
 * Auth: Authorization: Bearer $HEALTH_INGEST_TOKEN  (or X-Health-Token, or ?token=)
 * Stores de-duplicated samples per Europe/London day in Netlify Blobs
 * (store "jeeves-health"). See netlify/lib/health.js.
 */
import { ingest, authed } from "../lib/health.js";

export default async (req) => {
  if (req.method === "GET") return new Response("health-ingest ok", { status: 200 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  try {
    const result = await ingest(payload);
    return new Response(JSON.stringify({ ok: true, count: result.total, ...result }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("health-ingest failed", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

export const config = { path: "/health/ingest" };
