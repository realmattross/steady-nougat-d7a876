import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const { slug, html } = await req.json();
  const store = getStore("artifacts");
  await store.set(slug, html);
  const siteUrl = Netlify.env.get("URL") || "https://steady-nougat-d7a876.netlify.app";
  return Response.json({ url: `${siteUrl}/artifact/${slug}` });
};
