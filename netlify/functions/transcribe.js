export default async (req, context) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  const elKey = Netlify.env.get("ELEVENLABS_API_KEY");
  if (!elKey) return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: cors });
  try {
    const { audio } = await req.json();
    if (!audio) return new Response(JSON.stringify({ error: "No audio" }), { status: 400, headers: cors });

    const pcm = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
    if (pcm.length < 1000) {
      return new Response(JSON.stringify({ transcript: "" }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Try both sample rates - send two requests and return whichever works
    const tryTranscribe = async (sampleRate: number) => {
      const numChannels = 1, bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * bitsPerSample / 8;
      const blockAlign = numChannels * bitsPerSample / 8;
      const dataSize = pcm.length;
      const header = new ArrayBuffer(44);
      const view = new DataView(header);
      const writeStr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
      writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
      writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitsPerSample, true); writeStr(36, "data"); view.setUint32(40, dataSize, true);
      const wav = new Uint8Array(44 + dataSize);
      wav.set(new Uint8Array(header), 0); wav.set(pcm, 44);
      const blob = new Blob([wav], { type: "audio/wav" });
      const form = new FormData();
      form.append("file", blob, "audio.wav");
      form.append("model_id", "scribe_v1");
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST", headers: { "xi-api-key": elKey }, body: form,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text, rate: sampleRate };
    };

    // Try 16kHz first, then 8kHz
    const r16 = await tryTranscribe(16000);
    if (r16.ok) {
      const d = JSON.parse(r16.body);
      if (d.text) return new Response(JSON.stringify({ transcript: d.text }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const r8 = await tryTranscribe(8000);
    if (r8.ok) {
      const d = JSON.parse(r8.body);
      if (d.text) return new Response(JSON.stringify({ transcript: d.text }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Return debug info so we can see what ElevenLabs says
    return new Response(JSON.stringify({
      transcript: "",
      debug: { r16: { status: r16.status, body: r16.body }, r8: { status: r8.status, body: r8.body } }
    }), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: cors });
  }
};
export const config = { path: "/transcribe" };
