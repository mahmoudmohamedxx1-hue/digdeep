/**
 * v3.11.1 — live weather lookup for the chat lane.
 *
 * Weather is the most common live-facts chat ask, and the pages ranking for it
 * (weather.com, wunderground…) render the actual conditions with client-side
 * JS — so a text-extracting web pass regularly lands a source whose excerpt
 * carries no temperature at all, and the reply degrades to "I couldn't find
 * the exact conditions". wttr.in serves keyless JSON current conditions for
 * any place, so the chat web pass adds it as a first, always-fresh source.
 *
 * Fail-closed by design: any fetch/parse problem just returns null and the
 * lane proceeds with the ordinary engine results — weather lookup is an
 * enhancement, never a dependency.
 */
import type { SearchResult } from "./search";

/** match "weather/temperature/forecast/raining/how hot … in|at|for <place>" */
const PLACE_TAIL =
  /(?:\b(?:in|at|for|of)\s+)([a-z\u00C0-\u024F][a-z\u00C0-\u024F\s,'-]{1,40}?)(?=\s+(?:right\s+now|currently|today|tonight|tomorrow|this\s+(?:week|weekend|morning|evening|afternoon))\b|[?.!,;]|$)/i;

const WEATHER_TOPIC =
  /\b(?:weather|temperature|forecast|humid(?:ity|is it)|raining|rain|snow(?:ing)?|windy|how\s+(?:hot|cold|warm)|is\s+it\s+(?:hot|cold|rainy|sunny))\b/i;

/** "cairo weather" / "weather: cairo" style (topic without a preposition) */
const TOPIC_FIRST = /([a-z\u00C0-\u024F][a-z\u00C0-\u024F\s,'-]{1,40}?)\s+(?:weather|temperature|forecast)\b/i;

const NON_PLACES = new Set([
  "it", "there", "here", "that", "this", "today", "tomorrow", "now", "currently", "the", "my", "your",
  "what's", "whats", "how's", "hows", "is", "like", "tell", "show", "me", "us", "when's", "whens",
]);

/**
 * Extract the place a weather question is about, or null when the message is
 * not a weather ask (or no place is named — "is it raining?" has nothing to
 * look up). Returns a trimmed, single-spaced place name.
 */
export function weatherPlace(q: string): string | null {
  if (!WEATHER_TOPIC.test(q)) return null;
  const m = PLACE_TAIL.exec(q) ?? TOPIC_FIRST.exec(q);
  const raw = m?.[1]?.replace(/\s+/g, " ").trim().replace(/^the\s+/i, "");
  if (!raw || raw.length < 2) return null;
  const first = raw.split(" ")[0].toLowerCase();
  if (NON_PLACES.has(first)) return null;
  return raw;
}

interface WttrJ1 {
  current_condition?: {
    temp_C?: string; FeelsLikeC?: string; humidity?: string; precipMM?: string;
    windspeedKmph?: string; winddir16Point?: string; weatherDesc?: { value: string }[];
  }[];
  weather?: { maxtempC?: string; mintempC?: string }[];
}

/**
 * Fetch current conditions (plus today's high/low) from wttr.in and shape
 * them as a SearchResult whose snippet/excerpt already carry the facts.
 * 8s abort budget — the chat lane must stay fast.
 */
export async function fetchWeatherSource(place: string): Promise<SearchResult | null> {
  const url = `https://wttr.in/${encodeURIComponent(place)}?format=j1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "curl/8.0" } });
    if (!res.ok) return null;
    const d = (await res.json()) as WttrJ1;
    const c = d.current_condition?.[0];
    if (!c?.temp_C) return null;
    const desc = (c.weatherDesc?.[0]?.value ?? "").trim();
    const today = d.weather?.[0];
    const text =
      `Current conditions in ${place}: ${c.temp_C}°C (feels like ${c.FeelsLikeC ?? "?"}°C), ${desc || "conditions unavailable"}. ` +
      `Humidity ${c.humidity ?? "?"}%, wind ${c.windspeedKmph ?? "?"} km/h ${c.winddir16Point ?? ""}`.trim() + ", " +
      `precipitation ${c.precipMM ?? "0"} mm.` +
      (today?.maxtempC && today?.mintempC ? ` Today: high ${today.maxtempC}°C / low ${today.mintempC}°C.` : "");
    return {
      engine: "wttr.in",
      url: `https://wttr.in/${encodeURIComponent(place)}`,
      domain: "wttr.in",
      title: `Current weather in ${place} — wttr.in`,
      snippet: text,
      excerpt: text,
    };
  } catch {
    return null; // unreachable / rate-limited / non-JSON — fail closed
  } finally {
    clearTimeout(timer);
  }
}
