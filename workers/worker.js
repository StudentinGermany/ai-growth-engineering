// worker.js: entry point. It only receives requests and hands them to the right feature.
//
//   POST /website-check   experiment 1  (website-check.js)
//   POST /weather-plan    experiment 2  (weather-schedule.js)
//   POST /voice-note      experiment 3  (voice-note.js)
//   POST /event, /lead    funnel counters and optional email with consent  (funnel.js)
//
// Bindings (wrangler.jsonc):  AI (Workers AI), LIMITS (KV namespace). No secrets are needed.

import { json, cors } from "./shared.js";
import { websiteCheck } from "./website-check.js";
import { weatherPlan } from "./weather-schedule.js";
import { voiceNote } from "./voice-note.js";
import { logEvent, saveLead } from "./funnel.js";

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
    if (path === "/voice-note") return voiceNote(request, env, body);
    if (path === "/event") return logEvent(env, body);
    if (path === "/lead") return saveLead(env, body);
    return json({ error: "Not found" }, 404);
  },
};