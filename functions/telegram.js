export default async (req, context) => {
  if (req.method !== "POST") return new Response("OK");
  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  const aid = Netlify.env.get("TELEGRAM_CHAT_ID");
  const gcid = Netlify.env.get("GOOGLE_CLIENT_ID");
  const gcs = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const grt = Netlify.env.get("GOOGLE_REFRESH_TOKEN");
  if (!tok || !key) return new Response("OK");

  const send = async (c, t) => {
    await fetch("https://api.telegram.org/bot"+tok+"/sendMessage", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({chat_id:c, text:t.slice(0,4096), disable_web_page_preview:true})
    });
  };

  let body; try { body = await req.json(); } catch(e) { return new Response("OK"); }
  const msg = body?.message || body?.edited_message;
  if (!msg) return new Response("OK");
  const cid = String(msg.chat?.id);
  const txt = msg.text?.trim();
  if (aid && cid !== String(aid)) return new Response("OK");
  if (!txt) return new Response("OK");
  if (txt === "/start") { await send(cid, "Jarvis online."); return new Response("OK"); }

  // Google token
  const getGToken = async () => {
    if (!gcid||!gcs||!grt) return null;
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body: new URLSearchParams({client_id:gcid,client_secret:gcs,refresh_token:grt,grant_type:"refresh_token"})
      });
      return (await r.json()).access_token||null;
    } catch(e) { return null; }
  };

  // Calendar
  const getCalendar = async (gt, hours=24) => {
    if (!gt) return "Calendar unavailable";
    const now = new Date(), end = new Date(now.getTime()+hours*3600000);
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=15`,{headers:{Authorization:"Bearer "+gt}});
    const d = await r.json();
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
    if (!gt) return "Gmail unavailable";
    const r=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("in:inbox -category:promotions -category:social -from:noreply -from:no-reply")}&maxResults=6`,{headers:{Authorization:"Bearer "+gt}});
    const d=await r.json();
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

  const lower = txt.toLowerCase().trim();
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

  // Memory commands
  if(["memory","show memory","what do you remember"].includes(lower)){
    const m=await loadMem();
    if(!m.items?.length){await send(cid,"Nothing saved yet. Try: remember Ed Shaw is Day2 co-founder");return new Response("OK");}
    await send(cid,"Jarvis Memory:\n\n"+m.items.map((x,i)=>`${i+1}. ${x}`).join("\n"));return new Response("OK");
  }
  const rem=txt.match(/^remember[:\s]+(.+)$/is);
  if(rem){const fact=rem[1].trim();const m=await loadMem();m.items=[...(m.items||[]).filter(i=>i!==fact),fact].slice(-50);await saveMem(m);await send(cid,`Saved. ${m.items.length} item(s) in memory.`);return new Response("OK");}
  const fgt=txt.match(/^forget[:\s]+(.+)$/i);
  if(fgt){const term=fgt[1].trim().toLowerCase();const m=await loadMem();m.items=(m.items||[]).filter(i=>!i.toLowerCase().includes(term));await saveMem(m);await send(cid,`Forgotten: ${fgt[1].trim()}`);return new Response("OK");}

  // Direct commands
  if(["calendar","today","what's on today","my calendar"].includes(lower)){const gt=await getGToken();await send(cid,"Today:\n\n"+await getCalendar(gt,24));return new Response("OK");}
  if(["tomorrow","what's on tomorrow"].includes(lower)){const gt=await getGToken();await send(cid,"Tomorrow:\n\n"+await getCalendar(gt,48));return new Response("OK");}
  if(["emails","inbox","check emails","check my emails"].includes(lower)){const gt=await getGToken();await send(cid,"Inbox:\n\n"+await getEmails(gt));return new Response("OK");}
  if(lower==="clear history"){await saveHist([]);await send(cid,"History cleared.");return new Response("OK");}

  // Claude chat with web search
  try {
    const [m, hist, gt] = await Promise.all([loadMem(), loadHist(), getGToken()]);
    const today = new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"});

    const system = `You are Jarvis, Matt's personal AI on Telegram. Sharp, warm, efficient. Plain text only — no markdown, no asterisks, no bold.

Matt Ross — CEO Day2Health, Parkinson's platform. BGV accelerator. Northleach Cotswolds. Ex-Google/YouTube.
Today: ${today}
${m.items?.length?"IMPORTANT MEMORY — always apply these in conversation:\n"+m.items.map(i=>"- "+i).join("\n"):""}

You can take real actions: send emails, create calendar events, create Google Docs, search Drive.
When asked, show details and ask confirmation. Then output the action on the LAST LINE ONLY (nothing after it):
SEND_EMAIL|to@email.com|Subject|Body
CREATE_EVENT|Title|2026-03-20T14:00:00|2026-03-20T15:00:00|optional@attendee.com
CREATE_DOC|Document title|Optional content
SEARCH_DRIVE|search terms

Use web search for current info: news, weather, sports, research. Be concise.`;

    const messages=[...hist.flatMap(t=>[{role:"user",content:t.u},{role:"assistant",content:t.a}]),{role:"user",content:txt}];

    const r=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1024,system,messages,tools:[{type:"web_search_20250305",name:"web_search"}]})
    });
    const d=await r.json();

    // Handle tool use — extract only text blocks
    let reply = (d.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"No response").trim();

    // If Claude used web search, it may need another pass — check if reply is empty
    if (!reply && d.stop_reason === "tool_use") {
      // Make a follow-up call with tool results
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
      await send(cid,clean(visible||`Ready to send to ${p[1]?.trim()}. Shall I send this?`);
    } else if(last.startsWith("CREATE_EVENT|")){
      const p=last.split("|");
      await savePending({type:"event",title:p[1]?.trim(),start:p[2]?.trim(),end:p[3]?.trim(),attendees:p[4]?p[4].split(",").map(e=>e.trim()):[]});
      await send(cid,visible||`Ready to create: ${p[1]?.trim()}. Shall I add this?`);
    } else if(last.startsWith("CREATE_DOC|")){
      const p=last.split("|");
      await savePending({type:"doc",title:p[1]?.trim(),content:p.slice(2).join("|").trim()});
      await send(cid,visible||`Ready to create Google Doc: "${p[1]?.trim()}". Shall I create it?`);
    } else if(last.startsWith("SEARCH_DRIVE|")){
      const results=await searchDrive(gt,last.replace("SEARCH_DRIVE|","").trim());
      await saveHist([...hist,{u:txt.substring(0,400),a:reply.substring(0,800)}]);
      await send(cid,(visible?visible+"\n\n":"")+results);
    } else {
      await saveHist([...hist,{u:txt.substring(0,400),a:reply.substring(0,800)}]);
      await send(cid,clean(reply));
    }
  } catch(err){await send(cid,"ERROR: "+err.message?.slice(0,200));}
  return new Response("OK");
};

function clean(t) {
  return t.replace(/\*\*([^*]+)\*\*/g,"$1").replace(/\*([^*]+)\*/g,"$1").replace(/^#{1,6} /gm,"").replace(/`([^`]+)`/g,"$1");
}

function clean(t){return t.replace(/\*\*([^*]+)\*\*/g,"$1").replace(/\*([^*]+)\*/g,"$1").replace(/`([^`]+)`/g,"$1");}
function clean(t){return t.replace(/\*\*([^*]+)\*\*/g,"$1").replace(/\*([^*]+)\*/g,"$1").replace(/`([^`]+)`/g,"$1");}
function clean(t){return t.replace(/\*\*([^*]+)\*\*/g,"$1").replace(/\*([^*]+)\*/g,"$1").replace(/`([^`]+)`/g,"$1");}
export const config = { path: "/telegram" };
