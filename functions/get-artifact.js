import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const slug = context.params.slug;
  const store = getStore("artifacts");
  const html = await store.get(slug);
  if (!html) return new Response("Not found", { status: 404 });
  return new Response(html, { headers: { "Content-Type": "text/html" } });
};

export const config = { path: "/artifact/:slug" };
