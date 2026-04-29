/**
 * Jeeves on Telegram — thin proxy to the Mac brain.
 *
 * What this function does:
 *   1. Receives the Telegram webhook (text or voice note)
 *   2. Auth-checks against TELEGRAM_CHAT_ID (only Matt's chat is served)
 *   3. If voice: downloads the .ogg from Telegram, transcribes via Deepgram
 *   4. POSTs the text to the Mac via the Cloudflare Tunnel /chat endpoint
 *   5. Receives Jeeves's reply text
 *   6. Sends it back to Telegram as both a text message and an ElevenLabs
 *      voice note in the locked Jeeves voice
 *
 * What it deliberately doesn't do:
 *   - run its own LLM
 *   - know about calendar / gmail / spotify / memory / web search
 *   - hold conversation history (the Mac does, keyed by Telegram chat_id)
 *
 * One brain. Three surfaces (voice, browser, Telegram). This file is just a
 * pipe from Telegram into that brain.
 *
 * Required env vars on Netlify:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   DEEPGRAM_API_KEY                  (for transcribing voice notes)
 *   ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
 *   JEEVES_TUNNEL_URL                 (e.g. https://random.trycloudflare.com)
 *   JEEVES_AUTH_TOKEN                 (shared secret; matches what the Mac
 *                                      server expects in X-Auth header)
 */

export default async (req, context) => {
  if (req.method !== "POST") return new Response("OK");

  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const aid = Netlify.env.get("TELEGRAM_CHAT_ID");
  const dgKey = Netlify.env.get("DEEPGRAM_API_KEY");
  const elKey = Netlify.env.get("ELEVENLABS_API_KEY");
  const elVoice = Netlify.env.get("ELEVENLABS_VOICE_ID") || "wDsJlOXPqcvIUKdLXjDs";
  const tunnelUrl = (Netlify.env.get("JEEVES_TUNNEL_URL") || "").replace(/\/$/, "");
  const authToken = Netlify.env.get("JEEVES_AUTH_TOKEN") || "";

  if (!tok) return new Response("OK");
  if (!tunnelUrl) {
    // Misconfigured — fail loud so Matt knows on first message.
    return new Response("JEEVES_TUNNEL_URL not set", { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Telegram helpers
  // -------------------------------------------------------------------------
  const send = async (chatId, text) => {
    if (!text) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
      }),
    });
  };

  const speakAndSend = async (chatId, text) => {
    // Always send the text so it's readable and threadable.
    await send(chatId, text);
    if (!elKey || !text?.trim()) return;
    try {
      const stripped = text
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/#{1,6}\s/g, "")
        .slice(0, 5000);

      const elRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${elVoice}/stream`,
        {
          method: "POST",
          headers: { "xi-api-key": elKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: stripped,
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.55, similarity_boost: 0.80, style: 0.10 },
          }),
        }
      );
      if (!elRes.ok) {
        console.error("ElevenLabs error:", elRes.status, await elRes.text());
        return;
      }
      const audioBuffer = await elRes.arrayBuffer();
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append(
        "voice",
        new Blob([audioBuffer], { type: "audio/mpeg" }),
        "jeeves.mp3"
      );
      await fetch(`https://api.telegram.org/bot${tok}/sendVoice`, {
        method: "POST",
        body: formData,
      });
    } catch (err) {
      console.error("Voice error (non-fatal):", err.message);
    }
  };

  const downloadTelegramFile = async (fileId) => {
    const r = await fetch(`https://api.telegram.org/bot${tok}/getFile?file_id=${fileId}`);
    const d = await r.json();
    if (!d?.ok) return null;
    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${tok}/${d.result.file_path}`
    );
    if (!fileRes.ok) return null;
    return await fileRes.arrayBuffer();
  };

  // -------------------------------------------------------------------------
  // Deepgram — transcribe a voice note to text
  // -------------------------------------------------------------------------
  const transcribe = async (buffer) => {
    if (!dgKey || !buffer) return null;
    try {
      const r = await fetch(
        "https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&language=en",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${dgKey}`,
            "Content-Type": "audio/ogg",
          },
          body: buffer,
        }
      );
      const d = await r.json();
      return d?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || null;
    } catch (e) {
      console.error("Deepgram transcribe error:", e.message);
      return null;
    }
  };

  // -------------------------------------------------------------------------
  // Mac brain — POST to the tunnel /chat endpoint
  // -------------------------------------------------------------------------
  const askBrain = async (chatId, text) => {
    const r = await fetch(`${tunnelUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { "X-Auth": authToken } : {}),
      },
      body: JSON.stringify({ message: text, chat_id: String(chatId) }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      throw new Error(`brain returned ${r.status}: ${errText.slice(0, 200)}`);
    }
    const d = await r.json();
    return d?.reply || "(no reply)";
  };

  // -------------------------------------------------------------------------
  // Main
  // -------------------------------------------------------------------------
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response("OK");
  }

  const msg = body?.message || body?.edited_message;
  if (!msg) return new Response("OK");

  const cid = String(msg.chat?.id);
  if (aid && cid !== String(aid)) return new Response("OK"); // not Matt; ignore

  // /start handshake
  if (msg.text?.trim() === "/start") {
    await send(cid, "Jeeves online.");
    return new Response("OK");
  }

  // Resolve the user's text — either typed or transcribed from voice
  let text = msg.text?.trim();
  if (!text && msg.voice) {
    const buf = await downloadTelegramFile(msg.voice.file_id);
    text = await transcribe(buf);
    if (!text) {
      await send(cid, "Couldn't make out that voice note.");
      return new Response("OK");
    }
  }

  // Photos / docs / etc — punt for now; vision isn't wired into the brain yet
  if (!text) {
    if (msg.photo || msg.document) {
      await send(cid, "I can't see images or docs yet — text and voice only for now.");
    }
    return new Response("OK");
  }

  // Forward to the brain, send the reply back as both text + voice note
  try {
    const reply = await askBrain(cid, text);
    await speakAndSend(cid, reply);
  } catch (err) {
    await send(cid, `Couldn't reach Jeeves: ${err.message?.slice(0, 200)}`);
  }
  return new Response("OK");
};

export const config = { path: "/telegram" };
