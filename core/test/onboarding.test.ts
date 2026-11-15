/**
 * Onboarding: the two keys, their live checks, and the presets the wizard
 * offers. Network is stubbed everywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_PRESETS,
  SEARCH_KEY_URL,
  onboardingChecklist,
  onboardingState,
  verifyModelKey,
  verifySearchKey,
} from '../src/onboarding.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('provider presets are complete and OpenAI-compatible', () => {
  assert.ok(PROVIDER_PRESETS.length >= 4);
  for (const p of PROVIDER_PRESETS) {
    assert.match(p.baseUrl, /^https?:\/\//, `${p.id} base URL`);
    assert.ok(p.model.length > 0, `${p.id} model`);
    assert.ok(p.label.length > 0);
  }
  assert.match(SEARCH_KEY_URL, /^https:\/\//);
});

test('verifyModelKey: a real completion means the key works', async () => {
  let body: any;
  let auth = '';
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    auth = (init?.headers as Record<string, string>).authorization;
    return jsonResponse({ choices: [{ message: { content: 'pong' } }] });
  }) as unknown as typeof fetch;

  const res = await verifyModelKey({ baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-abc', model: 'gpt-4o-mini', fetchFn });
  assert.equal(res.ok, true);
  assert.match(res.detail, /key works/);
  assert.equal(auth, 'Bearer sk-abc');
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.max_tokens, 4, 'verification stays cheap');
});

test('verifyModelKey: distinguishes bad key, bad model, unreachable', async () => {
  const badKey = await verifyModelKey({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-bad',
    model: 'm',
    fetchFn: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(badKey.ok, false);
  assert.match(badKey.detail, /key rejected \(401\)/);

  const badModel = await verifyModelKey({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-ok',
    model: 'nope-model',
    fetchFn: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  });
  assert.equal(badModel.ok, false);
  assert.match(badModel.detail, /not found/);

  const unreachable = await verifyModelKey({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-ok',
    model: 'm',
    fetchFn: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.detail, /could not reach/);

  const rateLimited = await verifyModelKey({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-ok',
    model: 'm',
    fetchFn: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
  });
  assert.equal(rateLimited.ok, true, '429 still proves the key is valid');
});

test('verifyModelKey: empty input never touches the network', async () => {
  let called = 0;
  const fetchFn = (async () => {
    called += 1;
    return jsonResponse({});
  }) as unknown as typeof fetch;
  assert.equal((await verifyModelKey({ baseUrl: 'ftp://x', apiKey: 'k', model: 'm', fetchFn })).ok, false);
  assert.equal((await verifyModelKey({ baseUrl: 'https://x', apiKey: '', model: 'm', fetchFn })).ok, false);
  assert.equal((await verifyModelKey({ baseUrl: 'https://x', apiKey: 'k', model: '  ', fetchFn })).ok, false);
  assert.equal(called, 0);
});

test('verifySearchKey: 200 with a result is a pass, 401 is a fail', async () => {
  const good = await verifySearchKey({
    apiKey: 'BSA-ok',
    fetchFn: (async () =>
      jsonResponse({ web: { results: [{ title: 't', url: 'https://x.example', description: 'd' }] } })) as unknown as typeof fetch,
  });
  assert.equal(good.ok, true);
  assert.match(good.detail, /key works/);

  const bad = await verifySearchKey({
    apiKey: 'BSA-bad',
    fetchFn: (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /rejected/);

  const empty = await verifySearchKey({ apiKey: '  ' });
  assert.equal(empty.ok, false);
});

test('onboardingState + checklist tell a newcomer exactly what is missing', () => {
  const fresh = onboardingState({ apiKey: '', searchApiKey: '' });
  assert.deepEqual(fresh, { needsModelKey: true, needsSearchKey: true, complete: false });
  const lines = onboardingChecklist(fresh);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[ \] KEY 1/);
  assert.match(lines[1], /\[ \] KEY 2/);

  const modelOnly = onboardingState({ apiKey: 'sk-x', searchApiKey: '' });
  assert.equal(modelOnly.needsModelKey, false);
  assert.equal(modelOnly.needsSearchKey, true);
  assert.equal(modelOnly.complete, false, 'search key is recommended but the state still reports it');

  const done = onboardingState({ apiKey: 'sk-x', searchApiKey: 'BSA' });
  assert.equal(done.complete, true);
});
