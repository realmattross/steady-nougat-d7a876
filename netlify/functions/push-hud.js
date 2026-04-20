import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const store = getStore("jarvis-data");

  if (req.method === "GET") {
    try {
      const data = await store.get("hud-latest", { type: "json" });
      return new Response(JSON.stringify(data || { lines: [], ts: 0 }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ lines: [], ts: 0 }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }
  }

  if (req.method === "POST") {
    try {
      const { question, answer } = await req.json();
      const lines = [];
      if (question) lines.push(`> ${question.slice(0, 60)}`);
      if (answer) {
        // Word-wrap answer into ~40 char lines for HUD
        const words = answer.split(' ');
        let line = '';
        for (const word of words) {
          if ((line + ' ' + word).trim().length > 40) {
            if (line) lines.push(line.trim());
            line = word;
          } else {
            line = (line + ' ' + word).trim();
          }
        }
        if (line) lines.push(line.trim());
      }
      await store.setJSON("hud-latest", { lines: lines.slice(0, 6), ts: Date.now() });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: cors
      });
    }
  }

  return new Response("Method not allowed", { status: 405, headers: cors });
};
export const config = { path: "/push-hud" };
