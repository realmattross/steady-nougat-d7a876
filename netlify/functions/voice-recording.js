/**
 * Jeeves on the phone — recording handler.
 *
 * Twilio POSTs here once the caller's message is recorded. Downloads the
 * audio (authenticated, since the account requires auth for media),
 * transcribes it with ElevenLabs Scribe, then pushes the transcript AND the
 * audio itself into Telegram as a playable clip — no login, no link-chasing.
 *
 * Required env vars on Netlify:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ELEVENLABS_API_KEY   (already set)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN                      (required)
 *   VOICE_WEBHOOK_SECRET                                       (already set)
 */

const twiml = (body) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const tg = async (method, payload) => {
    if (!tok || !aid) return;
    const isForm = payload instanceof FormData;
    return fetch(`https://api.telegram.org/bot${tok}/${method}`, {
      method: "POST",
      headers: isForm ? {} : { "Content-Type": "application/json" },
      body: isForm ? payload : JSON.stringify(payload),
    }).catch(() => {});
  };

  const sendText = (text) =>
    tg("sendMessage", {
      chat_id: aid,
      text: String(text).slice(0, 4096),
      disable_web_page_preview: true,
    });

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
    await sendText(`\u260E\uFE0F Call from ${from} \u2014 no message left.`);
    return twiml(`<Say voice="Polly.Amy-Neural" language="en-GB">Thank you. Goodbye.</Say>`);
  }

  const work = (async () => {
    let blob = null;
    let problem = "";

    const headers = {};
    if (sid && auth) headers.Authorization = "Basic " + btoa(`${sid}:${auth}`);

    // Twilio sometimes reports the recording before the file is readable.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(`${recordingUrl}.mp3`, { headers });
        if (res.ok) {
          blob = await res.blob();
          break;
        }
        problem =
          res.status === 401
            ? "401 - Twilio credentials missing or wrong on Netlify"
            : `HTTP ${res.status}`;
        if (res.status !== 404 && res.status !== 502) break;
      } catch (e) {
        problem = e.message;
      }
      await sleep(attempt * 1500);
    }

    if (!blob) {
      await sendText(
        `\u{1F4DE} Voicemail from ${from}\n\nCouldn't fetch the recording (${problem}).\n\n${recordingUrl}.mp3`
      );
      return;
    }

    let transcript = "";
    try {
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
          transcript = `(transcription failed: HTTP ${stt.status})`;
        }
      }
    } catch (e) {
      transcript = `(transcription failed: ${e.message})`;
    }

    await sendText(
      `\u{1F4DE} Voicemail from ${from}${duration ? ` (${duration}s)` : ""}\n\n${
        transcript || "(no speech detected)"
      }`
    );

    // Playable audio straight into the chat - no Twilio login needed.
    const fd = new FormData();
    fd.append("chat_id", aid);
    fd.append("audio", blob, `voicemail-${Date.now()}.mp3`);
    fd.append("title", `Voicemail from ${from}`);
    if (duration) fd.append("duration", String(parseInt(duration, 10) || 0));
    await tg("sendAudio", fd);
  })();

  context.waitUntil?.(work);
  if (!context.waitUntil) await work;

  return twiml(`<Say voice="Polly.Amy-Neural" language="en-GB">Thank you. I will pass that on. Goodbye.</Say>`);
};

export const config = { path: "/voice/recording" };
