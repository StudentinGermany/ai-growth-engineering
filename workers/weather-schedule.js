import { MODEL, json, underLimits, parseJson, aiFailure } from "./shared.js";

// weather-schedule.js: Experiment 2, Weather Work Window

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

export async function weatherPlan(request, env, body) {
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
