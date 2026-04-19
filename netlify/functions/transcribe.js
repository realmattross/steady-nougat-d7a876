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
    if (pcm.length < 19200) {
      return new Response(JSON.stringify({ transcript: "" }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    const sampleRate = 16000, numChannels = 1, bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = pcm.length;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
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
    if (!res.ok) { const err = await res.text(); return new Response(JSON.stringify({ error: err }), { status: 500, headers: cors }); }
    const data = await res.json();
    return new Response(JSON.stringify({ transcript: data.text || "" }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};
export const config = { path: "/transcribe" };
