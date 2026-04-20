export default async (req, context) => {
  if (req.method !== "POST") return new Response("OK");
  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  const aid = Netlify.env.get("TELEGRAM_CHAT_ID");
  const gcid = Netlify.env.get("GOOGLE_CLIENT_ID");
  const gcs = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const grt = Netlify.env.get("GOOGLE_REFRESH_TOKEN");
  const elKey = Netlify.env.get("ELEVENLABS_API_KEY");
  const elVoice = Netlify.env.get("ELEVENLABS_VOICE_ID") || "onwK4e9ZLuTAKqWW03F9";
  const spClientId = Netlify.env.get("SPOTIFY_CLIENT_ID");
  const spClientSecret = Netlify.env.get("SPOTIFY_CLIENT_SECRET");
  const spRefreshToken = Netlify.env.get("SPOTIFY_REFRESH_TOKEN");
  if (!tok || !key) return new Response("OK");

  // Send plain text message
  const send = async (c, t) => {
    await fetch("https://api.telegram.org/bot"+tok+"/sendMessage", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({chat_id:c, text:t.slice(0,4096), disable_web_page_preview:true})
    });
  };

  // Send text + voice message (used for Claude conversation replies only)
  const speakAndSend = async (c, t) => {
    await send(c, t);
    if (!elKey) return;
    try {
      const stripped = t
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/#{1,6}\s/g, "")
        .slice(0, 5000);

      const elRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${elVoice}/stream`,
        {
          method: "POST",
          headers: {
            "xi-api-key": elKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: stripped,
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

if (!elRes.ok) {
  console.error("ElevenLabs error:", elRes.status, await elRes.text());
  return;
}
      const audioBuffer = await elRes.arrayBuffer();
      const formData = new FormData();
      formData.append("chat_id", c);
      formData.append(
        "voice",
        new Blob([audioBuffer], { type: "audio/mpeg" }),
        "jarvis.mp3"
      );

      await fetch(`https://api.telegram.org/bot${tok}/sendVoice`, {
        method: "POST",
        body: formData,
      });
    } catch (err) {
      console.error("Voice error (non-fatal):", err.message);
    }
  };

  let body; try { body = await req.json(); } catch(e) { return new Response("OK"); }
  const msg = body?.message || body?.edited_message;
  if (!msg) return new Response("OK");
  const cid = String(msg.chat?.id);
  const txt = msg.text?.trim();
  if (aid && cid !== String(aid)) return new Response("OK");
  if (!txt && !msg.photo && !msg.document) return new Response("OK");
  if (txt === "/start") { await send(cid, "Jarvis online."); return new Response("OK"); }

  // Google token
  let gTokenError = null;
  const getGToken = async () => {
    if (!gcid||!gcs||!grt) { gTokenError = "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN env vars"; return null; }
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body: new URLSearchParams({client_id:gcid,client_secret:gcs,refresh_token:grt,grant_type:"refresh_token"})
      });
      const d = await r.json();
      if (d.access_token) { gTokenError = null; return d.access_token; }
      gTokenError = `Google token refresh failed: ${d.error||"unknown"} — ${d.error_description||JSON.stringify(d)}`;
      return null;
    } catch(e) { gTokenError = `Google token fetch threw: ${e.message}`; return null; }
  };

  // Download file from Telegram
  const getTelegramFile = async (fileId) => {
    const r = await fetch(`https://api.telegram.org/bot${tok}/getFile?file_id=${fileId}`);
    const d = await r.json();
    if (!d.ok) return null;
    const filePath = d.result.file_path;
    const fileRes = await fetch(`https://api.telegram.org/file/bot${tok}/${filePath}`);
    const buffer = await fileRes.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return {
      base64: btoa(binary),
      mimeType: filePath.endsWith('.pdf') ? 'application/pdf' : 
                filePath.endsWith('.png') ? 'image/png' : 'image/jpeg',
      isImage: !filePath.endsWith('.pdf')
    };
  };

  // Calendar
  const getCalendar = async (gt, hours=24) => {
    if (!gt) return gTokenError ? `Calendar unavailable — ${gTokenError}` : "Calendar unavailable";
    const now = new Date(), end = new Date(now.getTime()+hours*3600000);
    return getCalendarRange(gt, now, end);
  };

  const getCalendarRange = async (gt, startDate, endDate) => {
    if (!gt) return gTokenError ? `Calendar unavailable — ${gTokenError}` : "Calendar unavailable";
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${startDate.toISOString()}&timeMax=${endDate.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=15`,{headers:{Authorization:"Bearer "+gt}});
    const d = await r.json();
    if (!r.ok) return `Calendar error ${r.status}: ${d.error?.message||JSON.stringify(d).slice(0,200)}`;
    if (!d.items?.length) return "No events";
    return d.items.map(e=>{
      const dt=e.start?.dateTime||e.start?.date||"";
      const t=dt.includes("T")?new Date(dt).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/London"}):"All day";
      return `${t} — ${e.summary||"Untitled"}`;
    }).join("\n");
  };

  const createEvent = async (gt,title,startISO,endISO,attendees=[]) => {
    if (!gt) return "Calendar unavailable";
    const ev={summary:title,start:{dateTime:startISO,timeZone:"Europe/London"},end:{dateTime:endISO,timeZone:"Europe/London"}};
    if (attendees.length) ev.attendees=attendees.map(e=>({email:e}));
    const r=await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify(ev)});
    const d=await r.json();
    return d.id?`Added: ${title}`:`Failed: ${d.error?.message||"unknown"}`;
  };

  // Gmail
  const getEmails = async (gt) => {
    if (!gt) return gTokenError ? `Gmail unavailable — ${gTokenError}` : "Gmail unavailable";
    const r=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("in:inbox -category:promotions -category:social -from:noreply -from:no-reply")}&maxResults=6`,{headers:{Authorization:"Bearer "+gt}});
    const d=await r.json();
    if (!r.ok) return `Gmail error ${r.status}: ${d.error?.message||JSON.stringify(d).slice(0,200)}`;
    if (!d.messages?.length) return "Inbox clear";
    const emails=await Promise.all(d.messages.slice(0,6).map(async m=>{
      const mr=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,{headers:{Authorization:"Bearer "+gt}});
      const md=await mr.json(); const h={};
      for(const hh of(md.payload?.headers||[]))h[hh.name]=hh.value;
      return `• ${(h.From||"?").replace(/<.*>/,"").trim().replace(/"/g,"")}: ${h.Subject||"No subject"}`;
    }));
    return emails.join("\n");
  };

  const sendEmail = async (gt,to,subject,bodyText) => {
    if (!gt) return "Gmail unavailable";
    try {
      const mime=`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`;
      const raw=btoa(unescape(encodeURIComponent(mime))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
      const r=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify({raw})});
      const d=await r.json();
      return d.id?`Sent to ${to}`:`Failed: ${d.error?.message||JSON.stringify(d)}`;
    } catch(e){return `Error: ${e.message}`;}
  };

  // Drive
  const searchDrive = async (gt,query) => {
    if (!gt) return "Drive unavailable";
    const r=await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`fullText contains '${query}' and trashed=false`)}&fields=files(id,name,webViewLink)&pageSize=5&orderBy=modifiedTime desc`,{headers:{Authorization:"Bearer "+gt}});
    const d=await r.json();
    if (!d.files?.length) return `No files found for "${query}"`;
    return d.files.map(f=>`${f.name}\n${f.webViewLink}`).join("\n\n");
  };

  // Spotify
  const getSpotifyToken = async () => {
    if (!spClientId || !spClientSecret || !spRefreshToken) return null;
    try {
      const creds = btoa(`${spClientId}:${spClientSecret}`);
      const r = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: spRefreshToken })
      });
      const d = await r.json();
      return d.access_token || null;
    } catch(e) { return null; }
  };

  const getSpotifyDeviceId = async (st) => {
    const r = await fetch("https://api.spotify.com/v1/me/player/devices", {
      headers: { Authorization: `Bearer ${st}` }
    });
    const d = await r.json();
    const active = d.devices?.find(dev => dev.is_active) || d.devices?.[0];
    return active?.id || null;
  };

  const spotifyNowPlaying = async () => {
    const st = await getSpotifyToken();
    if (!st) return "Spotify not connected. Set up SPOTIFY_REFRESH_TOKEN first.";
    try {
      const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
        headers: { Authorization: `Bearer ${st}` }
      });
      if (r.status === 204) return "Nothing playing on Spotify right now.";
      const d = await r.json();
      if (!d?.item) return "Nothing playing.";
      const artists = d.item.artists?.map(a => a.name).join(", ") || "Unknown";
      const track = d.item.name;
      const album = d.item.album?.name;
      const status = d.is_playing ? "▶ Now playing" : "⏸ Paused";
      return `${status}: ${track} — ${artists}\nAlbum: ${album}`;
    } catch(e) { return `Spotify error: ${e.message}`; }
  };

  const spotifyControl = async (action) => {
    const st = await getSpotifyToken();
    if (!st) return "Spotify not connected.";
    try {
      const deviceId = await getSpotifyDeviceId(st);
      const deviceParam = deviceId ? `?device_id=${deviceId}` : "";
      let endpoint, method;
      if (action === "play")   { endpoint = `/me/player/play${deviceParam}`;  method = "PUT"; }
      if (action === "pause")  { endpoint = `/me/player/pause${deviceParam}`; method = "PUT"; }
      if (action === "skip")   { endpoint = `/me/player/next${deviceParam}`;  method = "POST"; }
      if (action === "prev")   { endpoint = `/me/player/previous${deviceParam}`; method = "POST"; }
      const r = await fetch(`https://api.spotify.com/v1${endpoint}`, {
        method, headers: { Authorization: `Bearer ${st}` }
      });
      if (r.status === 204 || r.ok) {
        const labels = { play:"▶ Playing", pause:"⏸ Paused", skip:"⏭ Skipped", prev:"⏮ Previous track" };
        return labels[action] || "Done.";
      }
      const err = await r.json();
      return `Spotify error: ${err.error?.message || r.status}`;
    } catch(e) { return `Spotify error: ${e.message}`; }
  };

  const spotifySearch = async (query, type = "track") => {
    const st = await getSpotifyToken();
    if (!st) return "Spotify not connected.";
    try {
      const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${type}&limit=5`, {
        headers: { Authorization: `Bearer ${st}` }
      });
      const d = await r.json();
      if (type === "track") {
        const tracks = d.tracks?.items;
        if (!tracks?.length) return `No tracks found for "${query}"`;
        return tracks.map((t,i) => `${i+1}. ${t.name} — ${t.artists.map(a=>a.name).join(", ")}\n   spotify:track:${t.id}`).join("\n\n");
      }
      if (type === "playlist") {
        const playlists = d.playlists?.items;
        if (!playlists?.length) return `No playlists found for "${query}"`;
        return playlists.map((p,i) => `${i+1}. ${p.name} by ${p.owner?.display_name}\n   ${p.external_urls?.spotify}`).join("\n\n");
      }
      return "Search complete.";
    } catch(e) { return `Spotify error: ${e.message}`; }
  };

  const spotifyPlayUri = async (uri) => {
    const st = await getSpotifyToken();
    if (!st) return "Spotify not connected.";
    try {
      const deviceId = await getSpotifyDeviceId(st);
      if (!deviceId) return "No active Spotify device found. Open Spotify on your phone or Mac first.";
      const isTrack = uri.includes(":track:");
      const body = isTrack
        ? { uris: [uri], device_id: deviceId }
        : { context_uri: uri, device_id: deviceId };
      const r = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${st}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (r.status === 204 || r.ok) return `▶ Playing now`;
      const err = await r.json();
      return `Spotify error: ${err.error?.message || r.status}`;
    } catch(e) { return `Spotify error: ${e.message}`; }
  };

  // Google Docs
  const createDoc = async (gt,title,content) => {
    if (!gt) return {error:"No token"};
    try {
      const r=await fetch("https://docs.googleapis.com/v1/documents",{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify({title})});
      const d=await r.json();
      if (!d.documentId) return {error:d.error?.message||"Failed"};
      if (content) await fetch(`https://docs.googleapis.com/v1/documents/${d.documentId}:batchUpdate`,{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify({requests:[{insertText:{location:{index:1},text:content}}]})});
      return {docUrl:`https://docs.google.com/document/d/${d.documentId}/edit`,title};
    } catch(e){return {error:e.message};}
  };

  // Memory via Netlify Blobs
  const { getStore } = await import("@netlify/blobs");
  const store = getStore("jarvis");
  const loadMem = async () => {try{return(await store.get("memory",{type:"json"}))||{items:[]};}catch(e){return{items:[]};}};
  const saveMem = async (m) => {try{await store.setJSON("memory",m);}catch(e){}};
  const loadPending = async () => {try{return await store.get("pending-"+cid,{type:"json"});}catch(e){return null;}};
  const savePending = async (p) => {try{if(p)await store.setJSON("pending-"+cid,p);else await store.delete("pending-"+cid);}catch(e){}};
  const loadHist = async () => {try{return((await store.get("hist-"+cid,{type:"json"}))||{t:[]}).t;}catch(e){return[];}};
  const saveHist = async (t) => {try{await store.setJSON("hist-"+cid,{t:t.slice(-10)});}catch(e){}};

  // Handle photo messages
  if (msg.photo || msg.document) {
    const fileId = msg.photo ? msg.photo[msg.photo.length-1].file_id : msg.document.file_id;
    const caption = msg.caption || (msg.photo ? "What's in this image?" : "Summarise this document");
    try {
      const file = await getTelegramFile(fileId);
      if (!file) { await send(cid, "Could not download the file."); return new Response("OK"); }
      const [m, hist] = await Promise.all([loadMem(), loadHist()]);
      const today = new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
      const system = `You are Jarvis, Matt's personal AI on Telegram. Sharp, warm, efficient. Plain text only. Today: ${today}. ${m.items?.length?"Memory:\n"+m.items.map(i=>"- "+i).join("\n"):""}`;
      const content = file.isImage
        ? [{type:"image",source:{type:"base64",media_type:file.mimeType,data:file.base64}},{type:"text",text:caption}]
        : [{type:"document",source:{type:"base64",media_type:"application/pdf",data:file.base64}},{type:"text",text:caption}];
      const r = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1024,system,messages:[...hist.flatMap(t=>[{role:"user",content:t.u},{role:"assistant",content:t.a}]),{role:"user",content}]})
      });
      const d = await r.json();
      const reply = clean(d.content?.[0]?.text || "Could not process the file.");
      await saveHist([...hist,{u:"[sent a file: "+caption+"]",a:reply.substring(0,800)}]);
      await send(cid, reply);
    } catch(err) { await send(cid, "Error processing file: "+err.message?.slice(0,100)); }
    return new Response("OK");
  }

  const lower = txt.toLowerCase().trim();
  console.log("[jarvis] incoming:", JSON.stringify(txt), "→ lower:", JSON.stringify(lower));
  const yesWords = ["yes","yeah","yep","send it","do it","go ahead","confirm","ok","sure","send","create it","create","add it","y","sent","correct","go","proceed","do this","that's right","right","approved"];
  const YES = yesWords.includes(lower) || lower.startsWith("yes") || lower.startsWith("y ");
  const NO = ["no","cancel","nope","stop","abort"].includes(lower);

  // Pending confirmation
  const pending = await loadPending();
  if (pending) {
    if (YES) {
      await savePending(null);
      const gt = await getGToken();
      if (pending.type==="email") await send(cid, await sendEmail(gt,pending.to,pending.subject,pending.body));
      else if (pending.type==="event") await send(cid, await createEvent(gt,pending.title,pending.start,pending.end,pending.attendees||[]));
      else if (pending.type==="doc") {
        const res=await createDoc(gt,pending.title,pending.content||"");
        await send(cid,res.error?`Failed: ${res.error}`:`Created: ${res.title}\n\n${res.docUrl}`);
      }
      return new Response("OK");
    }
    if (NO){await savePending(null);await send(cid,"Cancelled.");return new Response("OK");}
  }

  // Memory commands (text only — no voice for system operations)
  if(["memory","show memory","what do you remember"].includes(lower)){
    const m=await loadMem();
    if(!m.items?.length){await send(cid,"Nothing saved yet. Try: remember Ed Shaw is Day2 co-founder");return new Response("OK");}
    await send(cid,"Jarvis Memory:\n\n"+m.items.map((x,i)=>`${i+1}. ${x}`).join("\n"));return new Response("OK");
  }
  const rem=txt.match(/^remember[:\s]+(.+)$/is);
  if(rem){const fact=rem[1].trim();const m=await loadMem();m.items=[...(m.items||[]).filter(i=>i!==fact),fact].slice(-500);await saveMem(m);await send(cid,`Saved. ${m.items.length} item(s) in memory.`);return new Response("OK");}
  const fgt=txt.match(/^forget[:\s]+(.+)$/i);
  if(fgt){const term=fgt[1].trim().toLowerCase();const m=await loadMem();m.items=(m.items||[]).filter(i=>!i.toLowerCase().includes(term));await saveMem(m);await send(cid,`Forgotten: ${fgt[1].trim()}`);return new Response("OK");}

  // Direct commands (text only — no voice for quick lookups)
  // Calendar — natural language matchers
  const calTomorrow = /\b(tomorrow|tmrw)\b/i;
  const calDayOfWeek = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
  const calToday = /\b(calendar|schedule|agenda|diary|what'?s (on|up|scheduled|coming)|what (have i got|do i have|is on)|events? (today|for today)?|meetings? (today|for today)?|any (events|meetings))\b/i;
  const inboxPat = /\b(inbox|check (my )?(emails?|mail|inbox|messages)|(any|new|recent|unread) (emails?|mail|messages?)|what'?s in (my )?(inbox|mail|email)|anything in (my )?(inbox|email|mail))\b/i;
  const wantsCalendar = calToday.test(lower) || calTomorrow.test(lower) || (calDayOfWeek.test(lower) && !inboxPat.test(lower));
  const wantsInbox = inboxPat.test(lower) && !calToday.test(lower) && !calTomorrow.test(lower);

  // Day-of-week lookup (e.g. "what's on Monday")
  if(calDayOfWeek.test(lower) && !inboxPat.test(lower) && !calTomorrow.test(lower)){
    const dayMap={sun:0,sunday:0,mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,wednesday:3,thu:4,thur:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6};
    const match=lower.match(calDayOfWeek);
    const targetDow=dayMap[match[1].toLowerCase()];
    const now=new Date();
    const daysAhead=((targetDow-now.getDay())+7)%7||7; // always look forward; same day = next week
    const startOfDay=new Date(now.getFullYear(),now.getMonth(),now.getDate()+daysAhead,0,0,0);
    const endOfDay=new Date(startOfDay.getTime()+24*3600000);
    const gt=await getGToken();
    const label=startOfDay.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"});
    const events=await getCalendarRange(gt,startOfDay,endOfDay);
    await send(cid,`${label}:\n\n${events}`);
    return new Response("OK");
  }

  if(calTomorrow.test(lower)){const gt=await getGToken();await send(cid,"Tomorrow:\n\n"+await getCalendar(gt,48));return new Response("OK");}
  if(wantsCalendar){console.log("[jarvis] calendar trigger hit");const gt=await getGToken();console.log("[jarvis] gt present?",!!gt,"err:",gTokenError);await send(cid,"Today:\n\n"+await getCalendar(gt,24));return new Response("OK");}
  if(wantsInbox){const gt=await getGToken();await send(cid,"Inbox:\n\n"+await getEmails(gt));return new Response("OK");}
  if(lower==="clear history"){await saveHist([]);await send(cid,"History cleared.");return new Response("OK");}
  if(["briefing","brief me","morning briefing","daily briefing","give me a briefing"].includes(lower)){
    const gt=await getGToken();
    const [cal,inbox]=await Promise.all([getCalendar(gt,24),getEmails(gt)]);
    await send(cid,"Calendar:\n\n"+cal+"\n\nInbox:\n\n"+inbox);
    return new Response("OK");
  }

  // Spotify direct commands
  if(["now playing","what's playing","spotify","whats playing","what is playing"].includes(lower)){
    await send(cid, await spotifyNowPlaying()); return new Response("OK");
  }
  if(["play","resume","spotify play"].includes(lower)){
    await send(cid, await spotifyControl("play")); return new Response("OK");
  }
  if(["pause","spotify pause"].includes(lower)){
    await send(cid, await spotifyControl("pause")); return new Response("OK");
  }
  if(["skip","next","next track","spotify skip","spotify next"].includes(lower)){
    await send(cid, await spotifyControl("skip")); return new Response("OK");
  }
  if(["previous","prev","back","spotify back","spotify previous"].includes(lower)){
    await send(cid, await spotifyControl("prev")); return new Response("OK");
  }
  const spSearch = lower.match(/^spotify search (.+)$/);
  if(spSearch){ await send(cid, await spotifySearch(spSearch[1])); return new Response("OK"); }
  const spPlaylist = lower.match(/^spotify playlist (.+)$/);
  if(spPlaylist){ await send(cid, await spotifySearch(spPlaylist[1], "playlist")); return new Response("OK"); }
  const spUri = txt.match(/spotify:(track|playlist|album|artist):[a-zA-Z0-9]+/);
  if(spUri){ await send(cid, await spotifyPlayUri(spUri[0])); return new Response("OK"); }

  // Claude chat — uses speakAndSend for voice replies
  try {
    const [m, hist, gt] = await Promise.all([loadMem(), loadHist(), getGToken()]);
    const today = new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"});

    const system = `You are Jarvis, Matt's personal AI on Telegram. Sharp, warm, efficient. Plain text only — no markdown, no asterisks, no bold.

Matt Ross — CEO Day2Health, Parkinson's platform. BGV accelerator. Northleach Cotswolds. Ex-Google/YouTube.
Today: ${today}
${m.items?.length?"IMPORTANT MEMORY — always apply these in conversation:\n"+m.items.map(i=>"- "+i).join("\n"):""}

You can take real actions: send emails, create calendar events, create Google Docs, search Drive, control Spotify.
When asked, show details and ask confirmation. Then output the action on the LAST LINE ONLY (nothing after it):
SEND_EMAIL|to@email.com|Subject|Body
CREATE_EVENT|Title|2026-03-20T14:00:00|2026-03-20T15:00:00|optional@attendee.com
CREATE_DOC|Document title|Optional content
SEARCH_DRIVE|search terms
SPOTIFY_SEARCH|track or artist name
SPOTIFY_PLAYLIST|playlist name
SPOTIFY_PLAY_URI|spotify:track:xxxx

Use web search for current info: news, weather, sports, research. Be concise.`;

    const messages=[...hist.flatMap(t=>[{role:"user",content:t.u},{role:"assistant",content:t.a}]),{role:"user",content:txt}];

    const r=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1024,system,messages,tools:[{type:"web_search_20250305",name:"web_search"}]})
    });
    const d=await r.json();

    let reply = (d.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"No response").trim();

    if (!reply && d.stop_reason === "tool_use") {
      const toolResults = d.content.filter(b=>b.type==="tool_use").map(b=>({
        type:"tool_result", tool_use_id:b.id, content:"Search completed"
      }));
      const r2=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1024,system,messages:[...messages,{role:"assistant",content:d.content},{role:"user",content:toolResults}]})
      });
      const d2=await r2.json();
      reply=(d2.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"No response").trim();
    }

    const lines=reply.split("\n");
    const last=lines[lines.length-1].trim();
    const visible=lines.slice(0,-1).join("\n").trim();

    if(last.startsWith("SEND_EMAIL|")){
      const p=last.split("|");
      await savePending({type:"email",to:p[1]?.trim(),subject:p[2]?.trim(),body:p.slice(3).join("|").trim()});
      await speakAndSend(cid,clean(visible||`Ready to send to ${p[1]?.trim()}. Shall I send this?`));
    } else if(last.startsWith("CREATE_EVENT|")){
      const p=last.split("|");
      await savePending({type:"event",title:p[1]?.trim(),start:p[2]?.trim(),end:p[3]?.trim(),attendees:p[4]?p[4].split(",").map(e=>e.trim()):[]});
      await speakAndSend(cid,visible||`Ready to create: ${p[1]?.trim()}. Shall I add this?`);
    } else if(last.startsWith("CREATE_DOC|")){
      const p=last.split("|");
      await savePending({type:"doc",title:p[1]?.trim(),content:p.slice(2).join("|").trim()});
      await speakAndSend(cid,visible||`Ready to create Google Doc: "${p[1]?.trim()}". Shall I create it?`);
    } else if(last.startsWith("SEARCH_DRIVE|")){
      const results=await searchDrive(gt,last.replace("SEARCH_DRIVE|","").trim());
      await saveHist([...hist,{u:txt.substring(0,400),a:reply.substring(0,800)}]);
      await send(cid,(visible?visible+"\n\n":"")+results);
    } else if(last.startsWith("SPOTIFY_SEARCH|")){
      const results=await spotifySearch(last.replace("SPOTIFY_SEARCH|","").trim());
      await saveHist([...hist,{u:txt.substring(0,400),a:reply.substring(0,800)}]);
      await send(cid,(visible?visible+"\n\n":"")+results);
    } else if(last.startsWith("SPOTIFY_PLAYLIST|")){
      const results=await spotifySearch(last.replace("SPOTIFY_PLAYLIST|","").trim(),"playlist");
      await saveHist([...hist,{u:txt.substring(0,400),a:reply.substring(0,800)}]);
      await send(cid,(visible?visible+"\n\n":"")+results);
    } else if(last.startsWith("SPOTIFY_PLAY_URI|")){
      const uri=last.replace("SPOTIFY_PLAY_URI|","").trim();
      const result=await spotifyPlayUri(uri);
      await saveHist([...hist,{u:txt.substring(0,400),a:reply.substring(0,800)}]);
      await send(cid,(visible?visible+"\n\n":"")+result);
    } else {
      await saveHist([...hist,{u:txt.substring(0,400),a:reply.substring(0,800)}]);
      fetch("https://steady-nougat-d7a876.netlify.app/push-hud",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:txt.slice(0,60),answer:clean(reply).slice(0,1500)})}).catch(()=>{});
      await speakAndSend(cid,clean(reply));
    }
  } catch(err){await send(cid,"ERROR: "+err.message?.slice(0,200));}
  return new Response("OK");
};

function clean(t){return t.replace(/\*\*([^*]+)\*\*/g,"$1").replace(/\*([^*]+)\*/g,"$1").replace(/`([^`]+)`/g,"$1");}

export const config = { path: "/telegram" };
