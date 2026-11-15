/**
 * Search providers: Brave (key #2) with the keyless DuckDuckGo fallback.
 * Every network call here is a stub — no sockets, no flakes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  braveSearch,
  extractDdgResults,
  resolveSearch,
  BRAVE_ENDPOINT,
} from '../src/search.js';
import { BrowserSandboxRuntime } from '../src/runtimes/browser-sandbox.js';

interface Call {
  url: string;
  init?: RequestInit;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const BRAVE_BODY = {
  web: {
    results: [
      {
        title: 'OpenClicky — one agent, every device',
        url: 'https://example.com/openclicky',
        description: 'A <strong>local-first</strong> agent that sees and acts.',
      },
      { title: 'No url here' }, // filtered out
    ],
  },
};

test('braveSearch sends the key as X-Subscription-Token and normalizes results', async () => {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return okJson(BRAVE_BODY);
  }) as unknown as typeof fetch;

  const hits = await braveSearch('open clicky', { apiKey: ' BSA-key ', fetchFn });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, BRAVE_ENDPOINT);
  assert.equal(url.searchParams.get('q'), 'open clicky');
  assert.equal(url.searchParams.get('count'), '8');

  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['x-subscription-token'], 'BSA-key', 'key is trimmed');

  assert.equal(hits.length, 1, 'entries without a url are dropped');
  assert.deepEqual(hits[0], {
    title: 'OpenClicky — one agent, every device',
    url: 'https://example.com/openclicky',
    snippet: 'A local-first agent that sees and acts.',
  });
});

test('braveSearch throws on a rejected key so callers can fall back', async () => {
  const fetchFn = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(() => braveSearch('x', { apiKey: 'bad', fetchFn }), /401/);
});

test('braveSearch with no key is a no-op, not a request', async () => {
  let called = 0;
  const fetchFn = (async () => {
    called += 1;
    return okJson(BRAVE_BODY);
  }) as unknown as typeof fetch;
  assert.deepEqual(await braveSearch('x', { apiKey: '   ', fetchFn }), []);
  assert.equal(called, 0);
});

const DDG_HTML = `
<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F&amp;rut=x" class='result-link'>Node.js</a></td></tr>
  <tr><td class='result-snippet'>JavaScript runtime built on V8.</td></tr>
</table>`;

test('extractDdgResults still parses the keyless listing', () => {
  const hits = extractDdgResults(DDG_HTML);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, 'https://nodejs.org/');
  assert.equal(hits[0].title, 'Node.js');
  assert.equal(hits[0].snippet, 'JavaScript runtime built on V8.');
});

test('resolveSearch: Brave wins when a key exists', async () => {
  let fallbackUsed = false;
  const fetchFn = (async () => okJson(BRAVE_BODY)) as unknown as typeof fetch;
  const hits = await resolveSearch('q', {
    provider: 'auto',
    apiKey: 'BSA',
    fetchFn,
    fallback: async () => {
      fallbackUsed = true;
      return [];
    },
  });
  assert.equal(fallbackUsed, false);
  assert.equal(hits[0].url, 'https://example.com/openclicky');
});

test('resolveSearch: no key → keyless fallback', async () => {
  let fetchCalls = 0;
  const hits = await resolveSearch('q', {
    provider: 'auto',
    apiKey: '',
    fetchFn: (async () => {
      fetchCalls += 1;
      return okJson(BRAVE_BODY);
    }) as unknown as typeof fetch,
    fallback: async () => [{ title: 'ddg', url: 'https://ddg.example', snippet: 's' }],
  });
  assert.equal(fetchCalls, 0, 'no key means no Brave call at all');
  assert.equal(hits[0].title, 'ddg');
});

test('resolveSearch: an expired Brave key downgrades instead of failing', async () => {
  const reasons: string[] = [];
  const hits = await resolveSearch('q', {
    provider: 'auto',
    apiKey: 'expired',
    fetchFn: (async () => new Response('quota', { status: 429 })) as unknown as typeof fetch,
    fallback: async () => [{ title: 'ddg', url: 'https://ddg.example', snippet: 's' }],
    onFallback: (r) => reasons.push(r),
  });
  assert.equal(hits[0].title, 'ddg');
  assert.match(reasons[0], /429/);
});

test('resolveSearch: provider=duckduckgo ignores a configured Brave key', async () => {
  let braveCalled = false;
  await resolveSearch('q', {
    provider: 'duckduckgo',
    apiKey: 'BSA',
    fetchFn: (async () => {
      braveCalled = true;
      return okJson(BRAVE_BODY);
    }) as unknown as typeof fetch,
    fallback: async () => [{ title: 'ddg', url: 'https://ddg.example', snippet: 's' }],
  });
  assert.equal(braveCalled, false);
});

test('BrowserSandboxRuntime: searchMode + setSearch hot-swap + Brave hits', async () => {
  const seen: string[] = [];
  const fetchFn = (async (url: string) => {
    seen.push(String(url));
    if (String(url).startsWith('https://api.search.brave.com')) return okJson(BRAVE_BODY);
    return new Response(DDG_HTML, { status: 200 });
  }) as unknown as typeof fetch;

  const rt = new BrowserSandboxRuntime({ fetchFn });
  assert.equal(rt.searchMode(), 'duckduckgo', 'no key yet');
  const ddgHits = await rt.search('node');
  assert.equal(ddgHits[0].title, 'Node.js');

  rt.setSearch({ apiKey: 'BSA-key' });
  assert.equal(rt.searchMode(), 'brave', 'key #2 saved → Brave');
  const braveHits = await rt.search('open clicky');
  assert.equal(braveHits[0].url, 'https://example.com/openclicky');
  assert.ok(seen.some((u) => u.startsWith('https://api.search.brave.com')));

  rt.setSearch({ provider: 'duckduckgo' });
  assert.equal(rt.searchMode(), 'duckduckgo', 'provider override wins');
});
