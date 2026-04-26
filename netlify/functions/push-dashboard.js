import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  try {
    const html = await req.text();
    if (!html || html.length < 100) {
      return new Response(JSON.stringify({ error: "Empty HTML" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const store = getStore("jarvis-data");
    await store.set("dashboard-html", html);
    return new Response(JSON.stringify({ ok: true, size: html.length }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/push-dashboard" };
