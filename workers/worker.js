// // Cloudflare Worker for the plancraft challenge, experiment 1: Website Quick Check.
// // Paste this into the Worker editor in the Cloudflare dashboard (no npm needed).
// //
// // Bindings to add in the dashboard (Settings > Bindings):
// //   - Workers AI, variable name: AI
// //   - KV namespace (optional but recommended), variable name: LIMITS
// //
// // Check the current model list in the Cloudflare docs, because models are retired over time.

// // const MODEL = "@cf/meta/llama-3.1-8b-instruct";
// const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
// const ALLOWED_ORIGIN = "*"; // later restrict to "https://studentingermany.github.io"
// const DAILY_GLOBAL_CAP = 60; // keep below the free daily allowance
// const DAILY_PER_IP_CAP = 5;
// const TOOLS = ["website-check"];
// const EVENTS = ["view", "start", "result", "email"];

// function cors() {
//   return {
//     "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
//     "Access-Control-Allow-Methods": "POST, OPTIONS",
//     "Access-Control-Allow-Headers": "Content-Type",
//   };
// }

// function json(data, status = 200) {
//   return new Response(JSON.stringify(data), {
//     status,
//     headers: { "Content-Type": "application/json", ...cors() },
//   });
// }

// export default {
//   async fetch(request, env) {
//     if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
//     if (request.method !== "POST") return json({ error: "Use POST" }, 405);

//     const path = new URL(request.url).pathname;
//     let body;
//     try {
//       body = await request.json();
//     } catch {
//       return json({ error: "Invalid JSON" }, 400);
//     }

//     if (path === "/website-check") return websiteCheck(request, env, body);
//     if (path === "/event") return logEvent(env, body);
//     if (path === "/lead") return saveLead(env, body);
//     return json({ error: "Not found" }, 404);
//   },
// };

// // ---------- rate limits (protects the free AI allowance) ----------
// async function underLimits(env, ip) {
//   if (!env.LIMITS) return true; // no KV bound: skip (fine for first tests)
//   const day = new Date().toISOString().slice(0, 10);
//   const gKey = `cap:global:${day}`;
//   const iKey = `cap:ip:${day}:${ip}`;
//   const g = parseInt((await env.LIMITS.get(gKey)) || "0", 10);
//   const i = parseInt((await env.LIMITS.get(iKey)) || "0", 10);
//   if (g >= DAILY_GLOBAL_CAP || i >= DAILY_PER_IP_CAP) return false;
//   await env.LIMITS.put(gKey, String(g + 1), { expirationTtl: 172800 });
//   await env.LIMITS.put(iKey, String(i + 1), { expirationTtl: 172800 });
//   return true;
// }

// // ---------- URL safety ----------
// function safeUrl(input) {
//   let raw = String(input || "").trim();
//   if (!raw) return null;
//   if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
//   let u;
//   try {
//     u = new URL(raw);
//   } catch {
//     return null;
//   }
//   if (!["http:", "https:"].includes(u.protocol)) return null;
//   const h = u.hostname.toLowerCase();
//   if (!h.includes(".")) return null; // blocks localhost and bare hostnames
//   if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return null; // no IP addresses
//   if (h.endsWith(".local") || h.endsWith(".internal")) return null;
//   return u;
// }

// async function fetchPage(url) {
//   const ctrl = new AbortController();
//   const timer = setTimeout(() => ctrl.abort(), 8000);
//   try {
//     const res = await fetch(url.toString(), {
//       signal: ctrl.signal,
//       redirect: "follow",
//       headers: { "User-Agent": "PlancraftChallengeBot/0.1 (prototype, public pages only)" },
//     });
//     if (!res.ok) return { error: `The site answered with status ${res.status}.` };
//     const type = res.headers.get("content-type") || "";
//     if (!type.includes("text/html")) return { error: "That address did not return a web page." };
//     const html = (await res.text()).slice(0, 300000);
//     return { html };
//   } catch {
//     return { error: "Could not open that website (timeout or blocked)." };
//   } finally {
//     clearTimeout(timer);
//   }
// }

// // ---------- facts we can check without AI (keeps the AI grounded) ----------
// function extractSignals(html) {
//   const get = (re) => (html.match(re) || [])[1] || "";
//   const clean = (s) => s.replace(/\s+/g, " ").trim();
//   const text = clean(
//     html
//       .replace(/<script[\s\S]*?<\/script>/gi, " ")
//       .replace(/<style[\s\S]*?<\/style>/gi, " ")
//       .replace(/<[^>]+>/g, " ")
//       .replace(/&nbsp;/g, " ")
//   );
//   return {
//     signals: {
//       title: clean(get(/<title[^>]*>([\s\S]*?)<\/title>/i)).slice(0, 160),
//       meta_description: clean(get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)).slice(0, 300),
//       mobile_viewport_tag: /<meta[^>]+name=["']viewport["']/i.test(html),
//       has_tel_link: /href=["']tel:/i.test(html),
//       has_mailto_link: /href=["']mailto:/i.test(html),
//       has_contact_form: /<form/i.test(html),
//       has_whatsapp_link: /wa\.me|api\.whatsapp\.com/i.test(html),
//       h1_count: (html.match(/<h1[\s>]/gi) || []).length,
//       image_count: (html.match(/<img[\s>]/gi) || []).length,
//       visible_text_length: text.length,
//     },
//     excerpt: text.slice(0, 5000),
//   };
// }

// // ---------- the AI step ----------
// function parseJson(out) {
//   if (out && typeof out === "object") return out;
//   const s = String(out || "");
//   const a = s.indexOf("{");
//   const b = s.lastIndexOf("}");
//   if (a === -1 || b === -1) return null;
//   try {
//     return JSON.parse(s.slice(a, b + 1));
//   } catch {
//     return null;
//   }
// }

// async function websiteCheck(request, env, body) {
//   const ip = request.headers.get("CF-Connecting-IP") || "unknown";
//   if (!(await underLimits(env, ip))) {
//     return json({ error: "Daily limit for this prototype reached. Please try again tomorrow." }, 429);
//   }

//   const url = safeUrl(body.url);
//   if (!url) return json({ error: "Please enter a valid website address, for example example-painter.de" }, 400);

//   const page = await fetchPage(url);
//   if (page.error) return json({ error: page.error }, 422);

//   const { signals, excerpt } = extractSignals(page.html);
//   const lang = body.lang === "de" ? "German" : "English";

//   const system =
//     "You review websites of small trade businesses (electricians, roofers, painters, plumbers). " +
//     "Use ONLY the facts provided. Do not invent anything. If you are unsure, say so. " +
//     "Write plain, short sentences for a busy craftsman. " +
//     `Answer in ${lang}. Reply with JSON only.`;

//   const user =
//     `Checked facts from the page:\n${JSON.stringify(signals)}\n\n` +
//     `Start of the visible page text:\n"""${excerpt}"""\n\n` +
//     "Return JSON with exactly this shape:\n" +
//     '{"business_guess":"trade and rough size if visible, else unknown",' +
//     '"summary":"one sentence on how easy it is for a customer to contact this business",' +
//     '"fixes":[{"title":"short","why":"one sentence","how":"one concrete step"},' +
//     '{"title":"","why":"","how":""},{"title":"","why":"","how":""}],' +
//     '"confidence":"low|medium|high"}\n' +
//     "Give exactly 3 fixes, ordered by how many enquiries they could win. " +
//     "Base every fix on the checked facts or the page text.";

//   let parsed = null;
//   try {
//     const out = await env.AI.run(MODEL, {
//       messages: [
//         { role: "system", content: system },
//         { role: "user", content: user },
//       ],
//       max_tokens: 700,
//     });
//     parsed = parseJson(out.response);
//   // } catch {
//   //   return json({ error: "The AI step failed. Please try again." }, 502);
//   // }
// } catch (err) {
//   console.error("Workers AI error:", err);
//   return json({
//     error: "The AI step failed.",
//     details: err instanceof Error ? err.message : String(err),
//   }, 502);
// }
//   if (!parsed || !Array.isArray(parsed.fixes)) {
//     return json({ error: "The AI answer could not be read. Please try again." }, 502);
//   }
//   return json({ url: url.toString(), signals, result: parsed });
// }

// // ---------- funnel events and leads ----------
// async function logEvent(env, body) {
//   if (!TOOLS.includes(body.tool) || !EVENTS.includes(body.event)) return json({ ok: false }, 400);
//   if (env.LIMITS) {
//     const key = `ev:${body.tool}:${body.event}`;
//     const n = parseInt((await env.LIMITS.get(key)) || "0", 10);
//     await env.LIMITS.put(key, String(n + 1));
//   }
//   return json({ ok: true });
// }

// async function saveLead(env, body) {
//   const email = String(body.email || "").trim();
//   if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Invalid email" }, 400);
//   if (body.consent !== true) return json({ error: "Consent is required" }, 400);
//   const record = {
//     email,
//     tool: String(body.tool || "").slice(0, 40),
//     site: String(body.site || "").slice(0, 200),
//     source: "challenge-prototype",
//     created: new Date().toISOString(),
//   };
//   if (env.LIMITS) {
//     // prototype data is deleted automatically after 30 days
//     await env.LIMITS.put(`lead:${Date.now()}`, JSON.stringify(record), { expirationTtl: 2592000 });
//   }
//   return json({ ok: true });
// }


// Cloudflare Worker for the plancraft challenge.
// One backend for all experiments:
//   POST /website-check   experiment 1: fetch a public website and suggest 3 fixes
//   POST /weather-plan    experiment 2: city + trade -> 7-day work window + customer messages
//   POST /event           funnel events (view, start, result, copy, cta, email)
//   POST /lead            optional email with consent
//
// Bindings (Settings > Bindings):  AI (Workers AI), LIMITS (KV namespace)
// No other secrets are needed. Weather data comes from Open-Meteo (no key).
//
// Check the current model list in the Cloudflare docs, because models are retired over time.

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const ALLOWED_ORIGIN = "*"; // at the end, restrict to "https://studentingermany.github.io"
const DEBUG = true; // set to false before you submit, so error details are not shown to visitors

// Caps protect the free AI allowance. All tools share them.
// While you test, the per-IP cap must be higher than the final value.
// After 5 real calls, check the Neuron usage in the Workers AI dashboard and set the global cap below the free daily allowance.
const DAILY_GLOBAL_CAP = 150;
const DAILY_PER_IP_CAP = 40;

const TOOLS = ["website-check", "weather-schedule"];
const EVENTS = ["view", "start", "result", "copy", "cta", "email"];

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);

    const path = new URL(request.url).pathname;
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    if (path === "/website-check") return websiteCheck(request, env, body);
    if (path === "/weather-plan") return weatherPlan(request, env, body);
    if (path === "/event") return logEvent(env, body);
    if (path === "/lead") return saveLead(env, body);
    return json({ error: "Not found" }, 404);
  },
};

// ---------- rate limits (protects the free AI allowance) ----------
async function underLimits(env, ip) {
  if (!env.LIMITS) return true; // no KV bound: skip (fine for first tests)
  const day = new Date().toISOString().slice(0, 10);
  const gKey = `cap:global:${day}`;
  const iKey = `cap:ip:${day}:${ip}`;
  const g = parseInt((await env.LIMITS.get(gKey)) || "0", 10);
  const i = parseInt((await env.LIMITS.get(iKey)) || "0", 10);
  if (g >= DAILY_GLOBAL_CAP || i >= DAILY_PER_IP_CAP) return false;
  await env.LIMITS.put(gKey, String(g + 1), { expirationTtl: 172800 });
  await env.LIMITS.put(iKey, String(i + 1), { expirationTtl: 172800 });
  return true;
}

// ---------- shared helpers ----------
function parseJson(out) {
  if (out && typeof out === "object") return out;
  const s = String(out || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

function aiFailure(err) {
  console.error("Workers AI error:", err);
  const out = { error: "The AI step failed. Please try again." };
  if (DEBUG) out.details = err instanceof Error ? err.message : String(err);
  return out;
}

// ======================================================================
// Experiment 1: Website Quick Check
// ======================================================================

// ---------- URL safety ----------
function safeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".")) return null; // blocks localhost and bare hostnames
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return null; // no IP addresses
  if (h.endsWith(".local") || h.endsWith(".internal")) return null;
  return u;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "PlancraftChallengeBot/0.1 (prototype, public pages only)" },
    });
    if (!res.ok) return { error: `The site answered with status ${res.status}.` };
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html")) return { error: "That address did not return a web page." };
    const html = (await res.text()).slice(0, 300000);
    return { html };
  } catch {
    return { error: "Could not open that website (timeout or blocked)." };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- facts we can check without AI (keeps the AI grounded) ----------
function extractSignals(html) {
  const get = (re) => (html.match(re) || [])[1] || "";
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const text = clean(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
  );
  return {
    signals: {
      title: clean(get(/<title[^>]*>([\s\S]*?)<\/title>/i)).slice(0, 160),
      meta_description: clean(get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)).slice(0, 300),
      mobile_viewport_tag: /<meta[^>]+name=["']viewport["']/i.test(html),
      has_tel_link: /href=["']tel:/i.test(html),
      has_mailto_link: /href=["']mailto:/i.test(html),
      has_contact_form: /<form/i.test(html),
      has_whatsapp_link: /wa\.me|api\.whatsapp\.com/i.test(html),
      h1_count: (html.match(/<h1[\s>]/gi) || []).length,
      image_count: (html.match(/<img[\s>]/gi) || []).length,
      visible_text_length: text.length,
    },
    excerpt: text.slice(0, 5000),
  };
}

async function websiteCheck(request, env, body) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await underLimits(env, ip))) {
    return json({ error: "Daily limit for this prototype reached. Please try again tomorrow." }, 429);
  }

  const url = safeUrl(body.url);
  if (!url) return json({ error: "Please enter a valid website address, for example example-painter.de" }, 400);

  const page = await fetchPage(url);
  if (page.error) return json({ error: page.error }, 422);

  const { signals, excerpt } = extractSignals(page.html);
  const lang = body.lang === "de" ? "German" : "English";

  const system =
    "You review websites of small trade businesses (electricians, roofers, painters, plumbers). " +
    "Use ONLY the facts provided. Do not invent anything. If you are unsure, say so. " +
    "Write plain, short sentences for a busy craftsman. " +
    `Answer in ${lang}. Reply with JSON only.`;

  const user =
    `Checked facts from the page:\n${JSON.stringify(signals)}\n\n` +
    `Start of the visible page text:\n"""${excerpt}"""\n\n` +
    "Return JSON with exactly this shape:\n" +
    '{"business_guess":"trade and rough size if visible, else unknown",' +
    '"summary":"one sentence on how easy it is for a customer to contact this business",' +
    '"fixes":[{"title":"short","why":"one sentence","how":"one concrete step"},' +
    '{"title":"","why":"","how":""},{"title":"","why":"","how":""}],' +
    '"confidence":"low|medium|high"}\n' +
    "Give exactly 3 fixes, ordered by how many enquiries they could win. " +
    "Base every fix on the checked facts or the page text.";

  let parsed = null;
  try {
    const out = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 700,
    });
    parsed = parseJson(out.response);
  } catch (err) {
    return json(aiFailure(err), 502);
  }
  if (!parsed || !Array.isArray(parsed.fixes)) {
    return json({ error: "The AI answer could not be read. Please try again." }, 502);
  }
  return json({ url: url.toString(), signals, result: parsed });
}

// ======================================================================
// Experiment 2: Weather Work Window
// ======================================================================

// Rules of thumb per trade. These are ASSUMPTIONS for the prototype, not safety advice.
// Real limits depend on the product data sheet, the job and safety rules.
const TRADES = {
  painter: { label: "Exterior painter", maxRain: 1, minTemp: 5, maxWind: 40 },
  roofer: { label: "Roofer", maxRain: 1, minTemp: 0, maxWind: 35 },
  mason: { label: "Bricklayer / concrete", maxRain: 1, minTemp: 5, maxWind: 50 },
  gardener: { label: "Landscaper / gardener", maxRain: 5, minTemp: 0, maxWind: 50 },
};

// Code decides which days are suitable. The AI only writes the explanation and the customer messages.
function classifyDay(d, rules) {
  const reasons = [];
  let rainMinor = false;
  let other = false;
  if (d.rain_mm > rules.maxRain) {
    reasons.push(`rain ${d.rain_mm} mm (limit ${rules.maxRain} mm)`);
    if (d.rain_mm <= rules.maxRain + 2) rainMinor = true;
    else other = true;
  }
  if (d.temp_min_c < rules.minTemp) {
    reasons.push(`min temperature ${d.temp_min_c} C (needs at least ${rules.minTemp} C)`);
    other = true;
  }
  if (d.wind_max_kmh > rules.maxWind) {
    reasons.push(`wind ${d.wind_max_kmh} km/h (limit ${rules.maxWind} km/h)`);
    other = true;
  }
  let status = "go";
  if (reasons.length) status = rainMinor && !other ? "maybe" : "no";
  return { status, reasons };
}

function weekday(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}

async function weatherPlan(request, env, body) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await underLimits(env, ip))) {
    return json({ error: "Daily limit for this prototype reached. Please try again tomorrow." }, 429);
  }

  const rules = TRADES[body.trade];
  if (!rules) return json({ error: "Please choose a trade." }, 400);
  const city = String(body.city || "").trim().slice(0, 80);
  if (city.length < 2) return json({ error: "Please enter a city." }, 400);
  const lang = body.lang === "de" ? "German" : "English";

  // 1) find the city
  let place = null;
  try {
    const g = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=" + encodeURIComponent(city)
    );
    if (!g.ok) throw new Error("geocoding status " + g.status);
    const gd = await g.json();
    const list = gd.results || [];
    place = list.find((r) => r.country_code === "DE") || list[0];
  } catch {
    return json({ error: "The city lookup failed. Please try again later." }, 502);
  }
  if (!place) return json({ error: "City not found. Try the city name only, for example Hamburg." }, 404);

  // 2) get the 7-day forecast
  let daily = null;
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=" + place.latitude +
      "&longitude=" + place.longitude +
      "&daily=precipitation_sum,temperature_2m_min,temperature_2m_max,wind_speed_10m_max" +
      "&timezone=auto&forecast_days=7";
    const f = await fetch(url);
    if (!f.ok) throw new Error("forecast status " + f.status);
    const fd = await f.json();
    daily = fd.daily;
  } catch {
    return json({ error: "The weather lookup failed. Please try again later." }, 502);
  }
  if (!daily || !Array.isArray(daily.time)) return json({ error: "No forecast data received." }, 502);

  const days = daily.time.map((date, i) => {
    const d = {
      date,
      weekday: weekday(date),
      rain_mm: daily.precipitation_sum[i],
      temp_min_c: daily.temperature_2m_min[i],
      temp_max_c: daily.temperature_2m_max[i],
      wind_max_kmh: daily.wind_speed_10m_max[i],
    };
    return { ...d, ...classifyDay(d, rules) };
  });

  // 3) code picks the days to talk about
  const fromIdx = days.findIndex((d, i) => i < 5 && d.status === "no");
  const toIdx = fromIdx === -1 ? -1 : days.findIndex((d, i) => i > fromIdx && d.status === "go");
  const maybeIdx = days.findIndex((d) => d.status === "maybe");
  const fromDay = fromIdx === -1 ? null : days[fromIdx];
  const toDay = toIdx === -1 ? null : days[toIdx];
  const maybeDay = maybeIdx === -1 ? null : days[maybeIdx];

  // 4) the AI explains and writes the messages
  const rows = days
    .map((d) => `${d.weekday} ${d.date}: ${d.status.toUpperCase()}${d.reasons.length ? " (" + d.reasons.join(", ") + ")" : ""}`)
    .join("\n");

  const system =
    "You help small trade businesses plan their week and talk to customers. " +
    "Write short, polite, plain messages. Use ONLY the facts given. " +
    "Do not invent weather, prices, times or promises. " +
    `Answer in ${lang}. Reply with JSON only.`;

  const user =
    `Trade: ${rules.label}\nCity: ${place.name}\nWeek (checked by code, GO = good to work, MAYBE = light rain possible, NO = not suitable):\n${rows}\n\n` +
    `Reschedule: ${fromDay && toDay ? `move an appointment from ${fromDay.weekday} ${fromDay.date} to ${toDay.weekday} ${toDay.date}` : "none"}\n` +
    `Heads-up day: ${maybeDay ? `${maybeDay.weekday} ${maybeDay.date}` : "none"}\n\n` +
    "Return JSON with exactly this shape:\n" +
    '{"summary":"two short sentences on how the week looks for this trade",' +
    '"message_reschedule":"a short message to a customer asking to move the appointment, using [Customer name] and [Your name]; empty string if Reschedule is none",' +
    '"message_heads_up":"a short message telling a customer that the appointment on the heads-up day might move because of rain, using [Customer name] and [Your name]; empty string if Heads-up day is none",' +
    '"tip":"one practical tip for this week"}';

  let ai = null;
  let aiError = null;
  try {
    const out = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 700,
    });
    const p = parseJson(out.response);
    if (p) {
      ai = {
        summary: String(p.summary || "").slice(0, 500),
        message_reschedule: fromDay && toDay ? String(p.message_reschedule || "").slice(0, 700) : "",
        message_heads_up: maybeDay ? String(p.message_heads_up || "").slice(0, 700) : "",
        tip: String(p.tip || "").slice(0, 300),
      };
    }
  } catch (err) {
    aiError = aiFailure(err);
  }

  return json({
    place: { name: place.name, region: place.admin1 || "", country: place.country || "" },
    trade: { label: rules.label, rules },
    days,
    plan: {
      from: fromDay ? fromDay.date : null,
      to: toDay ? toDay.date : null,
      heads_up: maybeDay ? maybeDay.date : null,
    },
    ai,
    ai_note: ai ? null : (aiError && aiError.details) || "The AI text could not be created this time.",
    credit: "Weather data by Open-Meteo.com (CC BY 4.0)",
  });
}

// ======================================================================
// Funnel events and leads
// ======================================================================
async function logEvent(env, body) {
  if (!TOOLS.includes(body.tool) || !EVENTS.includes(body.event)) return json({ ok: false }, 400);
  if (env.LIMITS) {
    const key = `ev:${body.tool}:${body.event}`;
    const n = parseInt((await env.LIMITS.get(key)) || "0", 10);
    await env.LIMITS.put(key, String(n + 1));
  }
  return json({ ok: true });
}

async function saveLead(env, body) {
  const email = String(body.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Invalid email" }, 400);
  if (body.consent !== true) return json({ error: "Consent is required" }, 400);
  const record = {
    email,
    tool: TOOLS.includes(body.tool) ? body.tool : "unknown",
    site: String(body.site || "").slice(0, 200),
    source: "challenge-prototype",
    created: new Date().toISOString(),
  };
  if (env.LIMITS) {
    // prototype data is deleted automatically after 30 days
    await env.LIMITS.put(`lead:${Date.now()}`, JSON.stringify(record), { expirationTtl: 2592000 });
  }
  return json({ ok: true });
}