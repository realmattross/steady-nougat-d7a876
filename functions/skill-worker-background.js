import { getStore } from "@netlify/blobs";

export default async (req, ctx) => {
  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  const aid = Netlify.env.get("TELEGRAM_CHAT_ID");
  const url = Netlify.env.get("URL") || "https://steady-nougat-d7a876.netlify.app";
  if (!tok || !key) return;

  const send = async (c, t) => {
    try {
      await fetch("https://api.telegram.org/bot" + tok + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: c, text: t.slice(0, 4096), disable_web_page_preview: true })
      });
    } catch (e) { console.error("send error:", e); }
  };

  let u;
  try { u = await req.json(); } catch (e) { return; }
  const msg = u?.message || u?.edited_message;
  if (!msg) return;
  const cid = String(msg.chat?.id);
  const txt = msg.text?.trim();
  if (aid && cid !== String(aid)) return;
  if (!txt) return;
  if (txt === "/start") { await send(cid, "Jarvis online. Memory active."); return; }

  // ── MEMORY ────────────────────────────────────────────────────────────────

  const memStore = () => getStore({ name: "jarvis-memory", consistency: "strong" });
  const histStore = () => getStore({ name: "jarvis-history", consistency: "strong" });

  async function loadMemory() {
    try {
      const data = await memStore().get("structured", { type: "json" });
      return data || { people: {}, projects: {}, commitments: [], other: [], updated: null };
    } catch (e) { return { people: {}, projects: {}, commitments: [], other: [], updated: null }; }
  }

  async function saveMemory(mem) {
    try {
      mem.updated = new Date().toISOString();
      await memStore().setJSON("structured", mem);
    } catch (e) { console.error("saveMemory error:", e.message); }
  }

  async function loadHistory() {
    try {
      const data = await histStore().get(cid, { type: "json" });
      return data?.turns || [];
    } catch (e) { return []; }
  }

  async function saveHistory(turns) {
    try {
      await histStore().setJSON(cid, { turns: turns.slice(-10), updated: new Date().toISOString() });
    } catch (e) { console.error("saveHistory error:", e.message); }
  }

  function buildMemoryContext(mem) {
    const lines = [];
    if (Object.keys(mem.people).length) {
      lines.push("PEOPLE:");
      for (const [k, v] of Object.entries(mem.people)) lines.push(`  ${k}: ${v}`);
    }
    if (Object.keys(mem.projects).length) {
      lines.push("PROJECTS & STATUS:");
      for (const [k, v] of Object.entries(mem.projects)) lines.push(`  ${k}: ${v}`);
    }
    if ((mem.commitments || []).length) {
      lines.push("COMMITMENTS & FOLLOW-UPS:");
      for (const c of mem.commitments) lines.push(`  - ${c}`);
    }
    if ((mem.other || []).length) {
      lines.push("OTHER:");
      for (const o of mem.other) lines.push(`  - ${o}`);
    }
    return lines.length ? lines.join("\n") : "";
  }

  function formatMemoryForDisplay(mem) {
    const lines = ["🧠 Jarvis Memory\n"];
    if (Object.keys(mem.people || {}).length) {
      lines.push("👤 People:");
      for (const [k, v] of Object.entries(mem.people)) lines.push(`  ${k}: ${v}`);
    }
    if (Object.keys(mem.projects || {}).length) {
      lines.push("\n📁 Projects:");
      for (const [k, v] of Object.entries(mem.projects)) lines.push(`  ${k}: ${v}`);
    }
    if ((mem.commitments || []).length) {
      lines.push("\n✅ Commitments:");
      for (const c of mem.commitments) lines.push(`  - ${c}`);
    }
    if ((mem.other || []).length) {
      lines.push("\n💡 Other:");
      for (const o of mem.other) lines.push(`  - ${o}`);
    }
    if (lines.length === 1) lines.push("Nothing saved yet.\n\nTry:\n  remember Ed Shaw is Day2 co-founder\n  remember BGV SHA signing imminent");
    if (mem.updated) lines.push(`\nLast updated: ${new Date(mem.updated).toLocaleString("en-GB")}`);
    return lines.join("\n");
  }

  async function addToMemory(text) {
    const mem = await loadMemory();
    const lower = text.toLowerCase();

    // Detect people
    const peopleKeywords = ["ed shaw", "gordon", "yumi", "eve delgado", "anna", "vivian", "akee", "tristan", "max", "esme", "john barter", "sam peters"];
    const isPerson = peopleKeywords.some(p => lower.includes(p)) ||
      /^[A-Z][a-z]+ [A-Z][a-z]+/.test(text.trim());

    // Detect projects/business
    const projectKeywords = ["bgv", "sha", "day2", "fitterstock", "cpd", "app", "pitch", "investor", "nhs", "techne", "netlify", "jarvis", "briefing", "campaign", "podcast", "long game"];
    const isProject = projectKeywords.some(p => lower.includes(p));

    // Detect commitments
    const commitmentKeywords = ["follow up", "need to", "must", "will", "promised", "chase", "reply", "deadline", "by ", "before ", "tomorrow", "this week"];
    const isCommitment = commitmentKeywords.some(p => lower.includes(p));

    if (isPerson && text.includes(":")) {
      const [name, ...rest] = text.split(":");
      mem.people[name.trim()] = rest.join(":").trim();
    } else if (isPerson && lower.includes(" is ")) {
      const [name, ...rest] = text.split(/ is /i);
      mem.people[name.trim()] = rest.join(" is ").trim();
    } else if (isCommitment) {
      mem.commitments = [...(mem.commitments || []).filter(c => c !== text).slice(-14), text];
    } else if (isProject) {
      const key = text.split(/[:.]/)[0].trim().substring(0, 40);
      mem.projects[key] = text;
    } else {
      mem.other = [...(mem.other || []).filter(o => o !== text).slice(-14), text];
    }

    await saveMemory(mem);
    return mem;
  }

  async function forgetFromMemory(term) {
    const mem = await loadMemory();
    const t = term.toLowerCase();
    for (const k of Object.keys(mem.people)) { if (k.toLowerCase().includes(t) || mem.people[k].toLowerCase().includes(t)) delete mem.people[k]; }
    for (const k of Object.keys(mem.projects)) { if (k.toLowerCase().includes(t) || mem.projects[k].toLowerCase().includes(t)) delete mem.projects[k]; }
    mem.commitments = (mem.commitments || []).filter(c => !c.toLowerCase().includes(t));
    mem.other = (mem.other || []).filter(o => !o.toLowerCase().includes(t));
    await saveMemory(mem);
    return mem;
  }

  // ── BUILT-IN COMMANDS ─────────────────────────────────────────────────────

  const lower = txt.toLowerCase().trim();

  // Show memory
  if (["memory", "show memory", "what do you remember", "what do you know"].includes(lower)) {
    const mem = await loadMemory();
    await send(cid, formatMemoryForDisplay(mem));
    return;
  }

  // Remember command
  const rememberMatch = lower.match(/^remember[:\s]+(.+)$/s);
  if (rememberMatch) {
    const fact = txt.replace(/^remember[:\s]+/i, "").trim();
    const mem = await addToMemory(fact);
    await send(cid, `Got it. Saved to memory.\n\nTotal: ${Object.keys(mem.people).length} people, ${Object.keys(mem.projects).length} projects, ${(mem.commitments||[]).length} commitments.`);
    return;
  }

  // Forget command
  const forgetMatch = lower.match(/^forget[:\s]+(.+)$/);
  if (forgetMatch) {
    await forgetFromMemory(forgetMatch[1].trim());
    await send(cid, `Forgotten anything related to "${forgetMatch[1].trim()}".`);
    return;
  }

  // Clear history
  if (lower === "clear history" || lower === "new conversation") {
    await saveHistory([]);
    await send(cid, "Conversation history cleared. Fresh start.");
    return;
  }

  // ── SKILL ROUTING ─────────────────────────────────────────────────────────

  const sk = txt.startsWith("slides:") ? "slides"
    : txt.startsWith("visualise:") || txt.startsWith("visualize:") ? "visualise"
    : txt.startsWith("frontend:") ? "frontend"
    : "chat";
  const pr = txt.replace(/^(slides|visualise|visualize|frontend|ui):\s*/i, "").trim();

  try {
    if (sk !== "chat") {
      await send(cid, `Generating ${sk}... ~20 seconds`);
      const sys = {
        slides: "COMPLETE single-file HTML slide deck. Day2Health teal 1D9E75, dark bg, DM Sans, arrow keys. ONLY raw HTML starting doctype html. No markdown.",
        visualise: "COMPLETE single-file HTML page with diagram. Day2Health teal 1D9E75, dark bg. ONLY raw HTML starting doctype html. No markdown.",
        frontend: "COMPLETE single-file HTML page. Responsive, Day2Health teal 1D9E75. ONLY raw HTML starting doctype html. No markdown."
      };
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2048, system: sys[sk], messages: [{ role: "user", content: "Build: " + pr }] })
      });
      const d = await r.json();
      const html = (d.content[0].text || "").trim();
      const store = getStore("artifacts");
      const slug = sk + "-" + Date.now();
      await store.set(slug, html);
      await send(cid, "Ready: " + url + "/artifact/" + slug);
      return;
    }

    // ── CHAT with memory + history ───────────────────────────────────────────

    const [mem, history] = await Promise.all([loadMemory(), loadHistory()]);
    const memContext = buildMemoryContext(mem);

    const today = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    const systemPrompt = `You are Jarvis, Matt's personal AI assistant on Telegram. Sharp, warm, efficient. Plain text only — no markdown, no asterisks, no bullet symbols.

Matt Ross — CEO Day2Health, Parkinson's digital health platform. BGV accelerator. Lives Northleach, Cotswolds. Former Google/YouTube.

Today: ${today}

${memContext ? `JARVIS MEMORY — use this silently and proactively. Surface relevant context without being asked. Flag time-sensitive items:\n${memContext}` : ""}

CONVERSATION RULES:
- Use conversation history for follow-on context — remember what was said earlier in this conversation
- Apply memory silently — never say "based on my memory" or "I remember that you told me"
- If something in memory is relevant, just use it naturally
- Flag commitments or deadlines if they're time-sensitive today
- Keep replies concise unless asked for detail
- When Matt tells you something new about a person, project or commitment, suggest saving it: "Want me to remember that?"`;

    // Build messages array with history
    const messages = [
      ...history.map(t => ([
        { role: "user", content: t.user },
        { role: "assistant", content: t.assistant }
      ])).flat(),
      { role: "user", content: txt }
    ];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1024, system: systemPrompt, messages })
    });

    const d = await r.json();
    const reply = d.content?.[0]?.text || "No response";

    // Save turn to history
    await saveHistory([...history, { user: txt.substring(0, 500), assistant: reply.substring(0, 1000) }]);

    // Auto-detect if Jarvis should suggest saving something
    await send(cid, reply);

  } catch (err) {
    console.error(err);
    await send(cid, "ERROR: " + err.message?.slice(0, 200));
  }
};

export const config = { path: "/.netlify/functions/skill-worker-background" };
