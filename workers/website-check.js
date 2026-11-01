import { MODEL, json, underLimits, parseJson, aiFailure } from "./shared.js";

// website-check.js: Experiment: Website Quick Check
// Code reads checkable facts from a public page, the AI turns them into 3 fixes. The AI never invents the facts.

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

export async function websiteCheck(request, env, body) {
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
