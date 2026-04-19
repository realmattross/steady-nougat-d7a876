export default async (req, context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const elKey = Netlify.env.get("ELEVENLABS_API_KEY");
  if (!elKey) return new Response(JSON.stringify({ error: "No API key" }), { status: 500 });

  try {
    // Expect raw PCM as base64 in JSON body
    const { audio, sampleRate } = await req.json();
    if (!audio) return new Response(JSON.stringify({ error: "No audio" }), { status: 400 });

    // Convert base64 to binary
    const binary = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
    const blob = new Blob([binary], { type: "audio/wav" });

    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("model_id", "scribe_v1");

    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": elKey },
      body: form,
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: err }), { status: 500 });
    }

    const data = await res.json();
    const transcript = data.text || "";

    return new Response(JSON.stringify({ transcript }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = { path: "/transcribe" };
