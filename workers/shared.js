// shared.js: settings and helpers that every feature uses (config, CORS, JSON answers, rate limits, AI error handling).
//
// Check the current model list in the Cloudflare docs, because models are retired over time.

export const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const ALLOWED_ORIGIN = "*"; // at the end, restrict to "https://studentingermany.github.io"
const DEBUG = true; // set to false before you submit, so error details are not shown to visitors

// Caps protect the free AI allowance. All tools share them.
// While you test, the per-IP cap must be higher than the final value.
// After 5 real calls, check the Neuron usage in the Workers AI dashboard and set the global cap below the free daily allowance.
const DAILY_GLOBAL_CAP = 150;
const DAILY_PER_IP_CAP = 40;

export const TOOLS = ["voice-note", "weather-schedule"];
// view = page opened, start = Record clicked, mic = microphone allowed, result = summary from a recording shown,
// example = example text used instead of a recording, copy = result copied, cta = plancraft link, premium = waitlist interest, email = waitlist email saved
export const EVENTS = ["view", "start", "mic", "result", "example", "copy", "cta", "premium", "email"];

export function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  };
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

// ---------- rate limits (protects the free AI allowance) ----------
export async function underLimits(env, ip) {
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
export function parseJson(out) {
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

export function aiFailure(err) {
  console.error("Workers AI error:", err);
  const out = { error: "The AI step failed. Please try again." };
  if (DEBUG) out.details = err instanceof Error ? err.message : String(err);
  return out;
}
