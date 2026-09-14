/**
 * Shared health-data helpers for the Apple Health -> Jeeves pipeline (Health Webhook app).
 *
 * Storage: Netlify Blobs store "jeeves-health"
 *   day/{YYYY-MM-DD}  -> { date, samples: { [uuid]: {t, v, u, s, e, ...} }, updated }
 *   meta/last-ingest  -> { at, syncSource, counts }
 *
 * Dates are Europe/London local dates. Sleep samples are filed under the date
 * they END (i.e. the morning you wake up); everything else under the date
 * they START.
 */
import { getStore } from "@netlify/blobs";

export const TZ = "Europe/London";
export const STORE = "jeeves-health";

// HealthKit identifiers we keep, with short keys used in storage.
export const TYPES = {
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierRestingHeartRate: "rhr",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_kcal",
  HKQuantityTypeIdentifierAppleExerciseTime: "exercise_min",
  HKQuantityTypeIdentifierBodyMass: "weight",
  HKQuantityTypeIdentifierOxygenSaturation: "spo2",
  HKQuantityTypeIdentifierVO2Max: "vo2max",
  HKQuantityTypeIdentifierRespiratoryRate: "resp",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "distance_m",
  HKCategoryTypeIdentifierSleepAnalysis: "sleep",
  workouts: "workout",
};

// HKCategoryValueSleepAnalysis
export const SLEEP = { 0: "inBed", 1: "asleep", 2: "awake", 3: "core", 4: "deep", 5: "rem" };
const ASLEEP = new Set(["asleep", "core", "deep", "rem"]);

// HKWorkoutActivityType (subset)
const WORKOUT_NAMES = {
  1: "Archery", 3: "Badminton", 5: "Basketball", 13: "Cycling", 16: "Elliptical",
  20: "Functional strength", 24: "Hiking", 25: "Ice skating", 26: "Martial arts", 30: "Pilates",
  33: "Rowing", 35: "Rugby", 37: "Running", 41: "Football", 44: "Stair climbing",
  46: "Swimming", 47: "Table tennis", 48: "Tennis", 50: "Strength training", 52: "Walking",
  57: "Yoga", 59: "Cross training", 62: "Mixed cardio", 63: "HIIT", 66: "Core training",
  70: "Cooldown", 73: "Stretching", 77: "Pickleball",
};

export const localDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

export const localTime = (iso) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export const todayLocal = () => localDate(new Date().toISOString());

export const shiftDate = (ymd, days) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

// Strong consistency: ingest does read-modify-write per day, and the morning
// summary may run seconds after a sync lands.
export const store = () => getStore({ name: STORE, consistency: "strong" });

// Health Webhook (hcwebhook.com) payload keys -> parser
// Each entry: [shortType, valueField, timeMode] where timeMode is "point" (time) or "range" (start_time/end_time)
const HW = {
  steps: ["steps", "count", "range"],
  distance: ["distance_m", "meters", "range"],
  active_calories: ["active_kcal", "kcal", "range"],
  resting_heart_rate: ["rhr", "bpm", "point"],
  heart_rate_variability: ["hrv", "rmssd_ms", "point"],
  oxygen_saturation: ["spo2", "percentage", "point"],
  respiratory_rate: ["resp", "breaths_per_min", "point"],
  weight: ["weight", "kg", "point"],
  vo2_max: ["vo2max", "ml_per_kg_per_min", "point"],
};

const titleCase = (s) => String(s || "Workout").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Merge a payload into per-day blobs. Accepts:
 *   - Health Webhook format: { timestamp, steps:[...], sleep:[...], ... }
 *   - HealthKit-style format: { data: { HKQuantityTypeIdentifier...: [...] } }
 * Samples are de-duplicated by a stable key (uuid, or type+time range).
 * Returns counts per short type.
 */
export async function ingest(payload) {
  const byDay = {}; // date -> { key -> sample }
  const counts = {};

  const put = (date, key, rec) => {
    if (!date || !key) return;
    (byDay[date] ||= {})[key] = rec;
    counts[rec.t] = (counts[rec.t] || 0) + 1;
  };

  // ---- Health Webhook format ----
  if (payload && !payload.data) {
    for (const [field, [short, vf, mode]] of Object.entries(HW)) {
      const arr = payload[field];
      if (!Array.isArray(arr)) continue;
      for (const s of arr) {
        const start = mode === "range" ? s.start_time : s.time;
        const end = mode === "range" ? s.end_time : s.time;
        if (!start) continue;
        let v = Number(s[vf]);
        if (short === "spo2" && v > 1) v = v / 100; // store as fraction like HealthKit
        put(localDate(start), `${short}|${start}|${end}`, { t: short, v, s: start, e: end });
      }
    }
    for (const s of payload.sleep || []) {
      const end = s.session_end_time || s.end_time;
      if (!end) continue;
      const dur = Number(s.duration_seconds || 0);
      const start = s.session_start_time || s.start_time || new Date(new Date(end) - dur * 1000).toISOString();
      const stages = {};
      for (const st of s.stages || []) {
        const name = st.stage === "light" ? "core" : st.stage; // Android naming -> HealthKit naming
        stages[name] = (stages[name] || 0) + Math.round(Number(st.duration_seconds || 0) / 60);
      }
      put(localDate(end), `sleep|${end}`, { t: "sleepsession", total: Math.round(dur / 60), stages, s: start, e: end });
    }
    for (const w of payload.exercise_sessions || []) {
      if (!w.start_time) continue;
      put(localDate(w.start_time), `workout|${w.start_time}`, {
        t: "workout", name: titleCase(w.type),
        dur: Math.round(Number(w.duration_seconds || 0) / 60),
        kcal: Math.round(Number(w.active_calories_kcal || 0)),
        dist: Math.round(Number(w.distance_meters || 0)),
        s: w.start_time, e: w.end_time,
      });
    }
    return finish(byDay, counts, payload);
  }

  // ---- HealthKit-style format ----
  const data = payload?.data || {};
  for (const [hk, short] of Object.entries(TYPES)) {
    const arr = data[hk];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (short === "workout") {
        put(localDate(s.startDate), s.uuid, {
          t: "workout",
          name: WORKOUT_NAMES[s.workoutActivityType] || `Workout ${s.workoutActivityType}`,
          dur: Math.round((s.durationSeconds || 0) / 60),
          kcal: Math.round(s.totalEnergyBurned || 0),
          dist: Math.round(s.totalDistance || 0),
          s: s.startDate, e: s.endDate,
        });
      } else if (short === "sleep") {
        const stage = SLEEP[s.value] ?? String(s.value);
        put(localDate(s.endDate), s.uuid, { t: "sleep", stage, s: s.startDate, e: s.endDate });
      } else {
        put(localDate(s.startDate), s.uuid, { t: short, v: Number(s.value), u: s.unit, s: s.startDate, e: s.endDate });
      }
    }
  }

  return finish(byDay, counts, payload);
}

async function finish(byDay, counts, payload) {
  const st = store();
  for (const [date, samples] of Object.entries(byDay)) {
    const key = `day/${date}`;
    const existing = (await st.get(key, { type: "json" })) || { date, samples: {} };
    Object.assign(existing.samples, samples);
    existing.updated = new Date().toISOString();
    await st.setJSON(key, existing);
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await st.setJSON("meta/last-ingest", {
    at: new Date().toISOString(),
    payloadTimestamp: payload?.timestamp || payload?.exportDate || null,
    counts,
    total,
    days: Object.keys(byDay).sort(),
  });

  return { counts, total, days: Object.keys(byDay).sort() };
}

/** Aggregate one day's samples into headline numbers. */
export async function dayStats(date) {
  const rec = await store().get(`day/${date}`, { type: "json" });
  const out = { date, steps: null, rhr: null, hrv: null, active_kcal: null, exercise_min: null,
    weight: null, spo2: null, vo2max: null, distance_km: null, sleep: null, workouts: [] };
  if (!rec) return out;

  const samples = Object.values(rec.samples || {});
  const sum = (t) => { const xs = samples.filter((s) => s.t === t); return xs.length ? xs.reduce((a, s) => a + (s.v || 0), 0) : null; };
  const avg = (t) => { const xs = samples.filter((s) => s.t === t); return xs.length ? xs.reduce((a, s) => a + (s.v || 0), 0) / xs.length : null; };
  const last = (t) => { const xs = samples.filter((s) => s.t === t).sort((a, b) => a.s.localeCompare(b.s)); return xs.length ? xs[xs.length - 1].v : null; };

  out.steps = sum("steps") != null ? Math.round(sum("steps")) : null;
  out.rhr = avg("rhr") != null ? Math.round(avg("rhr")) : null;
  out.hrv = avg("hrv") != null ? Math.round(avg("hrv")) : null;
  out.active_kcal = sum("active_kcal") != null ? Math.round(sum("active_kcal")) : null;
  out.exercise_min = sum("exercise_min") != null ? Math.round(sum("exercise_min")) : null;
  out.weight = last("weight") != null ? Math.round(last("weight") * 10) / 10 : null;
  out.spo2 = avg("spo2") != null ? Math.round(avg("spo2") * 1000) / 10 : null; // fraction -> %
  out.vo2max = last("vo2max") != null ? Math.round(last("vo2max") * 10) / 10 : null;
  out.distance_km = sum("distance_m") != null ? Math.round(sum("distance_m") / 100) / 10 : null;

  // Sleep (Health Webhook sessions): pick the longest session ending this day.
  const sessions = samples.filter((s) => s.t === "sleepsession").sort((a, b) => b.total - a.total);
  const sl = samples.filter((s) => s.t === "sleep");
  if (sessions.length) {
    const main = sessions[0];
    const st = main.stages || {};
    const staged = Object.keys(st).some((k) => ["deep", "rem", "core"].includes(k));
    out.sleep = {
      total_min: main.total,
      deep_min: st.deep || 0, rem_min: st.rem || 0, core_min: st.core || 0, awake_min: st.awake || 0,
      bed: main.s ? localTime(main.s) : null,
      wake: main.e ? localTime(main.e) : null,
      staged,
      sessions: sessions.length,
    };
  } else if (sl.length) {
    // Raw HealthKit samples: prefer staged (core/deep/rem/awake); fall back to inBed/asleep.
    const mins = (s) => (new Date(s.e) - new Date(s.s)) / 60000;
    const staged = sl.filter((s) => ["core", "deep", "rem", "awake"].includes(s.stage));
    const src = staged.length ? staged : sl.filter((s) => s.stage === "asleep");
    const fallback = sl.filter((s) => s.stage === "inBed");
    const use = src.length ? src : fallback;
    const asleep = use.filter((s) => ASLEEP.has(s.stage) || (!src.length && s.stage === "inBed"));
    const total = Math.round(asleep.reduce((a, s) => a + mins(s), 0));
    const stage = (name) => Math.round(sl.filter((s) => s.stage === name).reduce((a, s) => a + mins(s), 0));
    const starts = use.map((s) => s.s).sort();
    const ends = use.map((s) => s.e).sort();
    out.sleep = {
      total_min: total,
      deep_min: stage("deep"), rem_min: stage("rem"), core_min: stage("core"), awake_min: stage("awake"),
      bed: starts[0] ? localTime(starts[0]) : null,
      wake: ends.length ? localTime(ends[ends.length - 1]) : null,
      staged: staged.length > 0,
    };
  }

  out.workouts = samples.filter((s) => s.t === "workout").sort((a, b) => a.s.localeCompare(b.s))
    .map((w) => ({ name: w.name, dur: w.dur, kcal: w.kcal, dist_km: w.dist ? Math.round(w.dist / 100) / 10 : null, at: localTime(w.s) }));

  return out;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Baseline = mean over the N days before `date` for the given field getter. */
export async function baseline(date, days = 7) {
  const stats = [];
  for (let i = 1; i <= days; i++) stats.push(await dayStats(shiftDate(date, -i)));
  const pick = (f) => stats.map(f).filter((x) => typeof x === "number" && !isNaN(x));
  return {
    steps: mean(pick((s) => s.steps)),
    rhr: mean(pick((s) => s.rhr)),
    hrv: mean(pick((s) => s.hrv)),
    sleep_min: mean(pick((s) => s.sleep?.total_min)),
    active_kcal: mean(pick((s) => s.active_kcal)),
    n: stats.filter((s) => s.steps != null || s.sleep).length,
  };
}

const hm = (m) => (m == null ? "—" : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`);
const pct = (v, b) => (v == null || b == null || !b ? null : Math.round(((v - b) / b) * 100));
const arrow = (p) => (p == null ? "" : p > 0 ? ` (+${p}%)` : p < 0 ? ` (${p}%)` : " (=)");

/**
 * Morning message for `today`: last night's sleep (filed under today) and
 * yesterday's activity, against the 7-day baseline.
 */
export async function morningMessage(today = todayLocal()) {
  const yesterday = shiftDate(today, -1);
  const t = await dayStats(today);      // sleep ending this morning, early readings
  const y = await dayStats(yesterday);  // yesterday's activity
  const b = await baseline(today, 7);   // baseline for sleep (days before today)
  const by = await baseline(yesterday, 7);

  const flags = [];
  const lines = [];
  const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "short" }).format(new Date(`${today}T12:00:00Z`));
  lines.push(`Health — ${dayName}`);

  // Sleep
  if (t.sleep) {
    const p = pct(t.sleep.total_min, b.sleep_min);
    let s = `Sleep ${hm(t.sleep.total_min)}${arrow(p)}`;
    if (t.sleep.staged) s += ` · deep ${hm(t.sleep.deep_min)} · REM ${hm(t.sleep.rem_min)}`;
    if (t.sleep.bed && t.sleep.wake) s += ` · ${t.sleep.bed}–${t.sleep.wake}`;
    lines.push(s);
    if (t.sleep.total_min < 360) flags.push(`short sleep (${hm(t.sleep.total_min)})`);
    else if (p != null && p <= -20) flags.push(`sleep ${Math.abs(p)}% below your week`);
  } else {
    lines.push("Sleep: no data yet");
  }

  // Resting HR / HRV — use today's reading if present, else yesterday's
  const rhr = t.rhr ?? y.rhr, rhrB = b.rhr ?? by.rhr;
  const hrv = t.hrv ?? y.hrv, hrvB = b.hrv ?? by.hrv;
  const vitals = [];
  if (rhr != null) {
    vitals.push(`RHR ${rhr}${arrow(pct(rhr, rhrB))}`);
    if (rhrB != null && rhr - rhrB >= 5) flags.push(`resting HR up ${Math.round(rhr - rhrB)} bpm on your week`);
  }
  if (hrv != null) {
    vitals.push(`HRV ${hrv}${arrow(pct(hrv, hrvB))}`);
    const p = pct(hrv, hrvB);
    if (p != null && p <= -20) flags.push(`HRV ${Math.abs(p)}% below your week`);
  }
  if (t.spo2 ?? y.spo2) vitals.push(`SpO2 ${t.spo2 ?? y.spo2}%`);
  if (vitals.length) lines.push(vitals.join(" · "));

  // Yesterday's activity
  const act = [];
  if (y.steps != null) {
    act.push(`${y.steps.toLocaleString("en-GB")} steps${arrow(pct(y.steps, by.steps))}`);
    if (y.steps < 4000) flags.push(`low movement yesterday (${y.steps.toLocaleString("en-GB")} steps)`);
  }
  if (y.active_kcal != null) act.push(`${y.active_kcal} kcal active`);
  if (y.exercise_min != null) act.push(`${y.exercise_min} min exercise`);
  if (act.length) lines.push(`Yesterday: ${act.join(" · ")}`);
  if (y.workouts.length) {
    lines.push(`Workouts: ${y.workouts.map((w) => `${w.name} ${w.dur}m${w.dist_km ? ` ${w.dist_km}km` : ""}`).join(", ")}`);
  } else if (by.n >= 3) {
    // only mention if we have some history
    lines.push("Workouts: none logged");
  }
  if (y.weight ?? t.weight) lines.push(`Weight ${(t.weight ?? y.weight)} kg`);

  lines.push(flags.length ? `⚠ ${flags.join("; ")}` : "All within your usual range.");

  return { text: lines.join("\n"), flags, today: t, yesterday: y, baseline: b };
}

export async function sendTelegram(text) {
  const tok = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Netlify.env.get("TELEGRAM_CHAT_ID");
  if (!tok || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

export function authed(req) {
  const want = Netlify.env.get("HEALTH_INGEST_TOKEN");
  if (!want) return false;
  const h = req.headers.get("authorization") || "";
  const bearer = h.replace(/^Bearer\s+/i, "").trim();
  const custom = req.headers.get("x-health-token") || "";
  const q = new URL(req.url).searchParams.get("token") || "";
  return bearer === want || custom === want || q === want;
}
