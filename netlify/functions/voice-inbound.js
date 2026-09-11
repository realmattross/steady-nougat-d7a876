/**
 * Jeeves on the phone — inbound call handler.
 *
 * Twilio POSTs here when a call lands on +44 1372 656049.
 * Returns TwiML that greets the caller, records a message, and hands the
 * recording off to /voice/recording for transcription.
 *
 * Deliberately independent of the Mac brain: this must work when the Mac
 * is asleep and JEEVES_TUNNEL_URL is stale.
 *
 * Required env vars on Netlify:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (already set)
 *   VOICE_WEBHOOK_SECRET                   (new — shared secret in the URL)
 */

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );

const twiml = (body) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });

export default async (req, context) => {
  const url = new URL(req.url);
  const secret = Netlify.env.get("VOICE_WEBHOOK_SECRET");

  // Reject anything that isn't Twilio hitting the secret URL.
  if (secret && url.searchParams.get("k") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  let from = "unknown number";
  try {
    const form = await req.formData();
    from = form.get("From") || from;
  } catch {}

  // Fire a Telegram ping straight away, so a caller who hangs up mid-greeting
  // still shows up.
  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const aid = Netlify.env.get("TELEGRAM_CHAT_ID");
  if (tok && aid) {
    fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: aid,
        text: `\u260E\uFE0F Incoming call from ${from}`,
        disable_web_page_preview: true,
      }),
    }).catch(() => {});
  }

  const base = `${url.origin}/voice/recording${secret ? `?k=${encodeURIComponent(secret)}` : ""}`;

  return twiml(`
    <Say voice="Polly.Amy-Neural" language="en-GB">Good day. Matt is not available to take your call. I am his assistant. Please leave your name and a short message after the tone, and I will pass it on.</Say>
    <Record
      action="${xmlEscape(base)}"
      recordingStatusCallback="${xmlEscape(base)}"
      recordingStatusCallbackEvent="completed"
      maxLength="120"
      timeout="4"
      playBeep="true"
      trim="trim-silence" />
    <Say voice="Polly.Amy-Neural" language="en-GB">I did not catch anything. Goodbye.</Say>
  `);
};

export const config = { path: "/voice/inbound" };
