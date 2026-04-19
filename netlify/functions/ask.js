import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!key) return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: cors });
  try {
    const { message } = await req.json();
    if (!message) return new Response(JSON.stringify({ error: "No message" }), { status: 400, headers: cors });
    let memoryContext = "";
    try {
      const store = getStore("jarvis-data");
      const mem = await store.get("memory", { type: "json" });
      if (mem?.items?.length) {
        memoryContext = "\n\nWhat you know about Matt:\n" + mem.items.map(i => `- ${i}`).join("\n");
      }
    } catch (_) {}
    const system = `You are Jarvis, Matt's personal AI assistant on his G2 smart glasses HUD.
Rules: Reply in plain text only. No markdown, no asterisks, no bullet points, no headers.
Keep responses to 1-2 short sentences maximum — this displays on a tiny heads-up display.
Be direct and useful. Do not repeat the question. Do not echo back what was asked.${memoryContext}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 150, system, messages: [{ role: "user", content: message }] })
    });
    const data = await res.json();
    if (data.error) return new Response(JSON.stringify({ error: data.error.message }), { status: 500, headers: cors });
    let reply = data.content?.[0]?.text || "No response";
    reply = reply.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^#+\s+/gm, "").replace(/`([^`]+)`/g, "$1").trim();
    if (reply.length > 200) reply = reply.substring(0, 197) + "...";
    return new Response(JSON.stringify({ reply }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};
export const config = { path: "/ask" };
