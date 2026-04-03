export default async (req, context) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`<html><body><h2>Auth failed: ${error}</h2></body></html>`, {
      headers: { "Content-Type": "text/html" }
    });
  }

  if (!code) {
    return new Response(`<html><body><h2>No code received</h2></body></html>`, {
      headers: { "Content-Type": "text/html" }
    });
  }

  const clientId = Netlify.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Netlify.env.get("SPOTIFY_CLIENT_SECRET");
  const redirectUri = "https://steady-nougat-d7a876.netlify.app/spotify-callback";

  const creds = btoa(`${clientId}:${clientSecret}`);

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    })
  });

  const d = await r.json();

  if (d.error) {
    return new Response(`<html><body><h2>Token error: ${d.error_description}</h2></body></html>`, {
      headers: { "Content-Type": "text/html" }
    });
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Jarvis — Spotify Connected</title>
  <style>
    body { font-family: monospace; background: #0a0a0a; color: #00ff88; padding: 40px; }
    h2 { color: #1DB954; }
    .token { background: #111; padding: 16px; border-radius: 8px; word-break: break-all; margin: 12px 0; font-size: 13px; }
    .label { color: #888; font-size: 12px; margin-top: 16px; }
    .copy-hint { color: #555; font-size: 11px; margin-top: 24px; }
  </style>
</head>
<body>
  <h2>✅ Spotify Connected to Jarvis</h2>
  <p class="label">SPOTIFY_REFRESH_TOKEN — add this to Netlify environment variables:</p>
  <div class="token">${d.refresh_token}</div>
  <p class="label">Access token (expires in 1 hour — you don't need to save this):</p>
  <div class="token">${d.access_token}</div>
  <p class="copy-hint">Copy the refresh token above → Netlify dashboard → Site configuration → Environment variables → Add SPOTIFY_REFRESH_TOKEN</p>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
};

export const config = { path: "/spotify-callback" };
