/**
 * Web search providers.
 *
 * OpenClicky's `web.search` command has one job but two engines:
 *
 *  - Brave Search API (needs the second API key) — structured JSON, no HTML
 *    scraping, far better result quality.
 *  - DuckDuckGo lite (keyless fallback) — zero setup, works with no keys at
 *    all, parsed from HTML.
 *
 * The runtime picks Brave when a key is configured and silently falls back to
 * DuckDuckGo when the key is missing or the call fails, so search never hard
 * fails just because a key expired.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = 'auto' | 'brave' | 'duckduckgo';

export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const DDG_ENDPOINT = 'https://lite.duckduckgo.com/lite/?q=';

/** A tiny seam so tests never touch the network. */
export type FetchLike = typeof fetch;

export interface BraveSearchOptions {
  apiKey: string;
  count?: number;
  endpoint?: string;
  fetchFn?: FetchLike;
  /** Brave market/locale hint, e.g. "en-US". */
  country?: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

/** Strip Brave's inline highlight markup (e.g. <strong>) from snippets. */
function plain(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** Query the Brave Search API and normalize to SearchHit[]. */
export async function braveSearch(query: string, opts: BraveSearchOptions): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const key = opts.apiKey?.trim();
  if (!key) return [];

  const url = new URL(opts.endpoint ?? BRAVE_ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(opts.count ?? 8));
  if (opts.country) url.searchParams.set('country', opts.country);

  const res = await (opts.fetchFn ?? fetch)(url.toString(), {
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'x-subscription-token': key,
    },
  });
  if (!res.ok) {
    throw new Error(`brave search failed: ${res.status}`);
  }
  const data = (await res.json()) as BraveResponse;
  const results = data.web?.results ?? [];
  return results
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({ title: plain(r.title), url: r.url as string, snippet: plain(r.description) }))
    .slice(0, opts.count ?? 8);
}

/** DuckDuckGo HTML result listings (quote- and order-agnostic). */
export function extractDdgResults(html: string, limit = 8): SearchHit[] {
  const links: { url: string; title: string }[] = [];
  const snippets: string[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    if (!/class\s*=\s*["']result-link["']/i.test(attrs)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    links.push({ url: cleanDdgUrl(decodeEntities(href)), title: stripTags(m[2] ?? '') });
  }
  const snipRe = /class\s*=\s*["']result-snippet["']\s*>([\s\S]*?)<\/td>/gi;
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1] ?? ''));
  }
  return links.map((l, i) => ({ ...l, snippet: snippets[i] ?? '' })).slice(0, limit);
}

function cleanDdgUrl(href: string): string {
  const uddg = /uddg=([^&]+)/.exec(href)?.[1];
  if (uddg) return decodeURIComponent(uddg);
  return href.startsWith('//') ? 'https:' + href : href;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export interface ResolveSearchOptions {
  provider?: SearchProvider;
  apiKey?: string;
  fetchFn?: FetchLike;
  count?: number;
  /** Keyless fallback executor (usually the runtime's HTML getter). */
  fallback: (query: string) => Promise<SearchHit[]>;
  /** Called when Brave fails so callers can log/observe the downgrade. */
  onFallback?: (reason: string) => void;
}

/**
 * One entry point for `web.search`: Brave when configured, DuckDuckGo
 * otherwise. Never throws for a recoverable Brave problem — it downgrades.
 */
export async function resolveSearch(query: string, opts: ResolveSearchOptions): Promise<SearchHit[]> {
  const provider: SearchProvider = opts.provider ?? 'auto';
  const key = opts.apiKey?.trim() ?? '';
  const wantBrave = provider === 'brave' || (provider === 'auto' && key.length > 0);

  if (wantBrave && key.length > 0) {
    try {
      const hits = await braveSearch(query, { apiKey: key, fetchFn: opts.fetchFn, count: opts.count });
      if (hits.length > 0) return hits;
      opts.onFallback?.('brave returned no results');
    } catch (err) {
      opts.onFallback?.((err as Error).message);
    }
  }
  return opts.fallback(query);
}
