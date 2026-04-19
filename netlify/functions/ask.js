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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, system: "You are Jarvis, Matt personal AI. Be very brief, max 2 sentences, for a HUD display.", messages: [{ role: "user", content: message }] })
    });
    const data = await res.json();
    const reply = data.content?.[0]?.text || "No response";
    return new Response(JSON.stringify({ reply }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};
export const config = { path: "/ask" };
