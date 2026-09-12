/**
 * Jeeves on the phone - post-call webhook.
 *
 * ElevenLabs POSTs the completed conversation here. Formats the collected
 * details, summary and transcript, and pushes them to Telegram.
 *
 * Required env vars on Netlify:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (already set)
 *   VOICE_WEBHOOK_SECRET                   (already set - guards the URL)
 */

export default async (req, context) => {
  const url = new URL(req.url);
  const secret = Netlify.env.get("VOICE_WEBHOOK_SECRET");
  if (secret && url.searchParams.get("k") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const aid = Netlify.env.get("TELEGRAM_CHAT_ID");

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

  let payload = {};
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  // ElevenLabs wraps the conversation in `data` for post_call_transcription.
  const d = payload.data || payload;

  const meta = d.metadata || {};
  const analysis = d.analysis || {};
  const collected = analysis.data_collection_results || {};
  const transcript = Array.isArray(d.transcript) ? d.transcript : [];

  const caller =
    meta.phone_call?.external_number ||
    meta.phone_call?.from_number ||
    "unknown number";
  const duration = meta.call_duration_secs;

  const val = (k) => {
    const v = collected[k];
    if (!v) return null;
    const out = typeof v === "object" ? v.value : v;
    return out && String(out).trim() && String(out) !== "null" ? String(out).trim() : null;
  };

  const lines = [`\u{1F4DE} Call from ${caller}${duration ? ` (${duration}s)` : ""}`, ""];

  const name = val("caller_name");
  const number = val("callback_number");
  const subject = val("subject");
  const urgency = val("urgency");

  if (name) lines.push(`Name: ${name}`);
  if (number) lines.push(`Callback: ${number}`);
  if (subject) lines.push(`About: ${subject}`);
  if (urgency) lines.push(`Urgency: ${urgency}`);
  if (name || number || subject || urgency) lines.push("");

  const summary = analysis.transcript_summary;
  if (summary) {
    lines.push(summary.trim(), "");
  }

  if (transcript.length) {
    lines.push("\u2014 Transcript \u2014");
    for (const t of transcript) {
      const msg = (t.message || "").trim();
      if (!msg) continue;
      lines.push(`${t.role === "agent" ? "Jeeves" : "Caller"}: ${msg}`);
    }
  }

  const work = send(lines.join("\n"));
  context.waitUntil?.(work);
  if (!context.waitUntil) await work;

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config = { path: "/voice/agent-webhook" };
