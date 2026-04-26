import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore("jarvis-data");
  try {
    const html = await store.get("dashboard-html", { type: "text" });
    if (!html) {
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
        <h2>Dashboard not generated yet</h2>
        <p>Run <code>python3 ~/generate-dashboard.py</code> to generate it.</p>
        </body></html>`,
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" },
    });
  } catch (e) {
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
};

export const config = { path: "/dashboard" };
