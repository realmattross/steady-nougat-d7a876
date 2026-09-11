/**
 * Jeeves on the phone — recording handler.
 *
 * Twilio POSTs here once the caller's message is recorded. Downloads the
 * audio, transcribes it with ElevenLabs Scribe (same model as /transcribe),
 * and pushes caller + transcript + audio link into Telegram.
 *
 * Required env vars on Netlify:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ELEVENLABS_API_KEY   (already set)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN                      (new)
 *   VOICE_WEBHOOK_SECRET                                       (new)
 */

const twiml = (body) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });

export default async (req, context) => {
  const url = new URL(req.url);
  const secret = Netlify.env.get("VOICE_WEBHOOK_SECRET");
  if (secret && url.searchParams.get("k") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const aid = Netlify.env.get("TELEGRAM_CHAT_ID");
  const elKey = Netlify.env.get("ELEVENLABS_API_KEY");
  const sid = Netlify.env.get("TWILIO_ACCOUNT_SID");
  const auth = Netlify.env.get("TWILIO_AUTH_TOKEN");

  const send = async (text) => {
    if (!tok || !aid) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: aid,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
      }),
    }).catch(() => {});
  };

  let from = "unknown number";
  let recordingUrl = "";
  let duration = "";

  try {
    const form = await req.formData();
    from = form.get("From") || from;
    recordingUrl = form.get("RecordingUrl") || "";
    duration = form.get("RecordingDuration") || "";
  } catch {}

  if (!recordingUrl) {
    await send(`\u260E\uFE0F Call from ${from} — no message left.`);
    return twiml(`<Say voice="Polly.Amy-Neural" language="en-GB">Thank you. Goodbye.</Say>`);
  }

  // Transcribe in the background so Twilio gets its TwiML back promptly.
  const work = (async () => {
    let transcript = "";
    try {
      const headers = {};
      if (sid && auth) {
        headers.Authorization = "Basic " + btoa(`${sid}:${auth}`);
      }
      const audioRes = await fetch(`${recordingUrl}.mp3`, { headers });
      if (!audioRes.ok) throw new Error(`recording fetch ${audioRes.status}`);
      const blob = await audioRes.blob();

      if (elKey) {
        const fd = new FormData();
        fd.append("file", blob, "message.mp3");
        fd.append("model_id", "scribe_v1");
        const stt = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": elKey },
          body: fd,
        });
        if (stt.ok) {
          const d = await stt.json();
          transcript = (d.text || "").trim();
        } else {
          transcript = `(transcription failed: ${stt.status})`;
        }
      }
    } catch (e) {
      transcript = `(transcription failed: ${e.message})`;
    }

    const lines = [
      `\u{1F4DE} Voicemail from ${from}`,
      duration ? `${duration}s` : "",
      "",
      transcript || "(no speech detected)",
      "",
      `\u{1F3A7} ${recordingUrl}.mp3`,
    ].filter((l) => l !== undefined);

    await send(lines.join("\n"));
  })();

  context.waitUntil?.(work);
  if (!context.waitUntil) await work;

  return twiml(`<Say voice="Polly.Amy-Neural" language="en-GB">Thank you. I will pass that on. Goodbye.</Say>`);
};

export const config = { path: "/voice/recording" };
