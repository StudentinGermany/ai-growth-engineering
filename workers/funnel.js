import { TOOLS, EVENTS, json } from "./shared.js";

// funnel.js: funnel counters (POST /event) and optional email capture with consent (POST /lead)
// Numbers can be read in the Cloudflare dashboard: Storage & Databases > KV > your namespace. Keys look like ev:voice-note:view and lead:<timestamp>.

export async function logEvent(env, body) {
  if (!TOOLS.includes(body.tool) || !EVENTS.includes(body.event)) return json({ ok: false }, 400);
  if (env.LIMITS) {
    const key = `ev:${body.tool}:${body.event}`;
    const n = parseInt((await env.LIMITS.get(key)) || "0", 10);
    await env.LIMITS.put(key, String(n + 1));
  }
  return json({ ok: true });
}

const LEAD_TTL = 2592000; // leads are deleted automatically after 30 days
// only a few known fields are kept from the page
function cleanContext(c) {
  const o = {};
  if (!c || typeof c !== "object") return o;
  for (const k of ["trade", "city", "site", "business_guess", "notes", "job_type", "interest"]) {
    if (c[k]) o[k] = String(c[k]).slice(0, k === "notes" ? 500 : 120);
  }
  for (const k of ["has_phone_link", "has_contact_form"]) {
    if (typeof c[k] === "boolean") o[k] = c[k];
  }
  return o;
}

export async function saveLead(env, body) {
  const email = String(body.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Invalid email" }, 400);
  if (body.consent !== true) return json({ error: "Consent is required" }, 400);
  const exp = Math.floor(Date.now() / 1000) + LEAD_TTL;
  const record = {
    email,
    tool: TOOLS.includes(body.tool) ? body.tool : "unknown",
    site: String(body.site || "").slice(0, 200),
    context: cleanContext(body.context),
    source: "challenge-prototype",
    created: new Date().toISOString(),
    exp,
  };
  if (env.LIMITS) {
    await env.LIMITS.put(`lead:${Date.now()}`, JSON.stringify(record), { expiration: exp });
  }
  return json({ ok: true });
}
