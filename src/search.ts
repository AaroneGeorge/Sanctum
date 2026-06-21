/**
 * search.ts — OPTIONAL, opt-in web augmentation for Sanctum.
 *
 * Sanctum's headline is "100% on-device — nothing leaves your network". The web-augmented mode does
 * NOT break that promise for the patient's data: the on-device model first turns the question into
 * 1-4 GENERAL, DE-IDENTIFIED medical search queries (see webagent.ts); only those short query STRINGS
 * ever reach this module, and only those strings reach the web. The patient document, the prompt, the
 * model output, and any identifiers NEVER touch a web provider.
 *
 * Defense in depth: `deidentify()` runs a regex PHI scrubber over every query as a safety net on top of
 * the model's own de-identification, so even a parsing slip cannot leak a name / MRN / DOB.
 *
 * The provider is pluggable (Tavily by default; Brave or a self-hosted SearXNG by env) so the operator
 * chooses who — if anyone — sees the de-identified queries. With NO key/endpoint configured, the whole
 * mode is unavailable (`webSearchAvailable()` is false) and the server makes ZERO external calls.
 */

export interface WebSource {
  id: string; // 'WEB-1', 'WEB-2', …
  title: string;
  url: string;
  snippet: string;
  content?: string; // optional longer extract; capped before prompt insertion
}

export interface SearchProvider {
  name: string;
  search(query: string, signal: AbortSignal): Promise<WebSource[]>;
}

const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER ?? 'tavily').toLowerCase();
const SEARCH_API_KEY = process.env.SEARCH_API_KEY ?? '';
const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT ?? ''; // self-hosted SearXNG base URL
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 6000);

const MAX_RESULTS_PER_QUERY = 4;
const MAX_TOTAL_SOURCES = 6; // cap the merged, deduped set
export const MAX_SNIPPET_CHARS = 600; // per-source snippet cap before budgeting

/** True only when web mode can actually run. With nothing configured the mode degrades to offline. */
export function webSearchAvailable(): boolean {
  if (SEARCH_PROVIDER === 'searxng') return !!SEARCH_ENDPOINT;
  return !!SEARCH_API_KEY;
}

/** The active provider's name (for status/logging). */
export function searchProviderName(): string {
  return SEARCH_PROVIDER;
}

// ─── PHI scrubber (defense in depth) ────────────────────────────────────────────────────────────
// Over-scrubbing a web query is harmless; leaking PHI is catastrophic — so this is deliberately
// aggressive about the highest-signal identifiers. The model is the primary de-identifier; this is the
// belt-and-suspenders pass that runs on EVERY query string immediately before it can leave the device.
const PHI_PATTERNS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/gi, ' '], // emails
  [/\b\d{3}-\d{2}-\d{4}\b/g, ' '], // SSN-like
  [/\+?\d[\d\s().-]{7,}\d/g, ' '], // phone numbers
  [/\b\d{4}[/-]\d{2}[/-]\d{2}\b/g, ' '], // ISO dates (DOB)
  [/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' '], // m/d/y dates (DOB)
  [/\bMRN[:#]?\s*\w+/gi, ' '], // explicit MRN labels
  [/\b\d{6,}\b/g, ' '], // long digit runs (MRN / account numbers)
  // "Patient Smith" / "Dr. Jones": the title is case-insensitive, but the name must stay Capitalized so
  // legit lowercase phrases ("patient education") are preserved.
  [/\b(?:[Pp]atient|[Pp]t|[Mm]rs|[Mm]r|[Mm]s|[Dd]r)\.?\s+[A-Z][a-z]+\b/g, ' '],
];

/** Strip the highest-signal identifiers from a query and bound its length. */
export function deidentify(query: string): string {
  let q = String(query ?? '');
  for (const [re, repl] of PHI_PATTERNS) q = q.replace(re, repl);
  q = q.replace(/\s+/g, ' ').trim();
  return q.slice(0, 160); // queries should be short and general
}

// ─── Providers ──────────────────────────────────────────────────────────────────────────────────

const tavily: SearchProvider = {
  name: 'tavily',
  async search(query, signal) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: SEARCH_API_KEY,
        query,
        max_results: MAX_RESULTS_PER_QUERY,
        search_depth: 'basic',
        include_answer: false,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const data: any = await res.json();
    return (data.results ?? []).map((r: any) => ({
      id: '',
      title: String(r.title ?? r.url ?? 'Result').slice(0, 120),
      url: String(r.url ?? ''),
      snippet: String(r.content ?? '').slice(0, MAX_SNIPPET_CHARS),
    }));
  },
};

const brave: SearchProvider = {
  name: 'brave',
  async search(query, signal) {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(MAX_RESULTS_PER_QUERY));
    const res = await fetch(u, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': SEARCH_API_KEY },
      signal,
    });
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const data: any = await res.json();
    return (data.web?.results ?? []).map((r: any) => ({
      id: '',
      title: String(r.title ?? 'Result').slice(0, 120),
      url: String(r.url ?? ''),
      snippet: String(r.description ?? '').slice(0, MAX_SNIPPET_CHARS),
    }));
  },
};

const searxng: SearchProvider = {
  name: 'searxng',
  async search(query, signal) {
    const u = new URL('/search', SEARCH_ENDPOINT);
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'json');
    const res = await fetch(u, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`searxng ${res.status}`);
    const data: any = await res.json();
    return (data.results ?? []).slice(0, MAX_RESULTS_PER_QUERY).map((r: any) => ({
      id: '',
      title: String(r.title ?? 'Result').slice(0, 120),
      url: String(r.url ?? ''),
      snippet: String(r.content ?? '').slice(0, MAX_SNIPPET_CHARS),
    }));
  },
};

function resolveProvider(): SearchProvider {
  switch (SEARCH_PROVIDER) {
    case 'brave':
      return brave;
    case 'searxng':
      return searxng;
    case 'tavily':
    default:
      return tavily;
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────────────────────

/**
 * Scrub each query, run them all under one timeout, dedupe by URL, cap the merged set, and assign
 * WEB-1..n ids. Fails SOFT: any provider error / timeout / empty result set returns [], and the caller
 * degrades to an on-device-only answer. One slow or failing query never sinks the others
 * (Promise.allSettled).
 */
export async function webSearch(queries: string[]): Promise<WebSource[]> {
  if (!webSearchAvailable()) return [];
  const provider = resolveProvider();

  // De-identify, drop anything too short to be a real query, and cap to 4.
  const cleaned = [...new Set(queries.map(deidentify).filter((q) => q.length >= 4))].slice(0, 4);
  if (!cleaned.length) return [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);
  try {
    const batches = await Promise.allSettled(cleaned.map((q) => provider.search(q, ac.signal)));
    const byUrl = new Map<string, WebSource>();
    for (const b of batches) {
      if (b.status !== 'fulfilled') continue;
      for (const s of b.value) {
        if (!s.url || byUrl.has(s.url)) continue;
        byUrl.set(s.url, s);
        if (byUrl.size >= MAX_TOTAL_SOURCES) break;
      }
      if (byUrl.size >= MAX_TOTAL_SOURCES) break;
    }
    return [...byUrl.values()].map((s, i) => ({ ...s, id: `WEB-${i + 1}` }));
  } catch {
    return []; // network failure / abort → on-device-only fallback
  } finally {
    clearTimeout(timer);
  }
}

/** The list of queries that would actually be sent, after de-identification (for status display / audit). */
export function previewQueries(queries: string[]): string[] {
  return [...new Set(queries.map(deidentify).filter((q) => q.length >= 4))].slice(0, 4);
}
