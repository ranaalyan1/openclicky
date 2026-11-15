import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ConnectorGateway, FileTokenVault, InMemoryTokenVault, type ConnectorSpec } from '../src/runtimes/connectors.js';

const APIKEY_SPEC: ConnectorSpec = {
  id: 'demo',
  name: 'Demo API',
  description: 'key-authed demo',
  baseUrl: 'https://api.demo.example',
  allowedPaths: ['/v1/'],
  auth: { type: 'apiKey' },
};

const OAUTH_SPEC: ConnectorSpec = {
  id: 'oauthdemo',
  name: 'OAuth Demo',
  description: 'oauth demo',
  baseUrl: 'https://api.oauth.example',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://oauth.example/authorize',
    tokenUrl: 'https://oauth.example/token',
    clientId: 'cli3nt',
    scopes: ['read', 'write'],
  },
};

/** fetch mock: records requests, serves canned responses per host. */
function fakeFetch(canned: Record<string, { status: number; body: unknown }>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const hit = canned[String(url)];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, requests };
}

function invoke(gw: ConnectorGateway, commandId: string, args: Record<string, string>) {
  return gw.invoke({
    invocationId: 'inv-' + commandId,
    commandId,
    commandVersion: 'v1',
    args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, { kind: 'string', value: v }])) as any,
  });
}

test('connector.list shows connectors and connection state', async () => {
  const gw = new ConnectorGateway({ connectors: [APIKEY_SPEC], fetchFn: fakeFetch({}).fn });
  const before = await invoke(gw, 'connector.list', {});
  assert.match((before.data as any).value, /demo — Demo API/);

  await invoke(gw, 'connector.connect', { connectorId: 'demo', secret: 'sk-demo' });
  const after = await invoke(gw, 'connector.list', {});
  assert.match((after.data as any).value, /connected/);
});

test('apiKey flow: secret stored, Authorization header injected, body returned', async () => {
  const { fn, requests } = fakeFetch({ 'https://api.demo.example/v1/me': { status: 200, body: { login: 'alyan' } } });
  const vault = new InMemoryTokenVault();
  const gw = new ConnectorGateway({ connectors: [APIKEY_SPEC], vault, fetchFn: fn });

  await invoke(gw, 'connector.connect', { connectorId: 'demo', secret: 'sk-123' });
  assert.equal(vault.get('demo')?.accessToken, 'sk-123');

  const res = await invoke(gw, 'connector.call', { connectorId: 'demo', path: '/v1/me' });
  assert.equal(res.ok, true);
  assert.match((res.data as any).value, /alyan/);
  assert.equal(requests[0].init.headers ? (requests[0].init.headers as any).authorization : undefined, 'Bearer sk-123');
});

test('scope enforcement: calls outside the connector origin/paths are refused', async () => {
  const { fn } = fakeFetch({});
  const gw = new ConnectorGateway({ connectors: [APIKEY_SPEC], fetchFn: fn });
  await invoke(gw, 'connector.connect', { connectorId: 'demo', secret: 'sk-x' });

  const wrongPath = await invoke(gw, 'connector.call', { connectorId: 'demo', path: '/v2/admin' });
  assert.equal(wrongPath.ok, false);
  assert.match(wrongPath.error!.message, /allowed scope/);

  const wrongOrigin = await invoke(gw, 'connector.call', { connectorId: 'demo', path: 'https://evil.example/v1/steal' });
  assert.equal(wrongOrigin.ok, false);
});

test('unconnected connectors refuse calls with a pointer to connect', async () => {
  const gw = new ConnectorGateway({ connectors: [APIKEY_SPEC], fetchFn: fakeFetch({}).fn });
  const res = await invoke(gw, 'connector.call', { connectorId: 'demo', path: '/v1/me' });
  assert.equal(res.ok, true); // informational, not an error
  assert.match((res.data as any).value, /not connected yet/);
});

test('OAuth flow: authorize URL with PKCE, then code exchange stores the token', async () => {
  const { fn, requests } = fakeFetch({
    'https://oauth.example/token': { status: 200, body: { access_token: 'oauth-tok', refresh_token: 'ref' } },
    'https://api.oauth.example/whoami': { status: 200, body: { name: 'Alyan' } },
  });
  const vault = new InMemoryTokenVault();
  const gw = new ConnectorGateway({ connectors: [OAUTH_SPEC], vault, fetchFn: fn });

  const step1 = await invoke(gw, 'connector.connect', { connectorId: 'oauthdemo' });
  assert.equal(step1.ok, true);
  const cardUrl = JSON.parse(step1.cards![0].json).url as string;
  assert.match(cardUrl, /client_id=cli3nt/);
  assert.match(cardUrl, /code_challenge=/);
  assert.match(cardUrl, /code_challenge_method=S256/);

  const step2 = await invoke(gw, 'connector.connect', { connectorId: 'oauthdemo', code: 'the-code' });
  assert.equal(step2.ok, true);
  assert.equal(vault.get('oauthdemo')?.accessToken, 'oauth-tok');

  const tokenCall = requests.find((r) => r.url === 'https://oauth.example/token');
  assert.ok(tokenCall);
  const body = String(tokenCall.init.body);
  assert.match(body, /code=the-code/);
  assert.match(body, /code_verifier=/);

  const api = await invoke(gw, 'connector.call', { connectorId: 'oauthdemo', path: '/whoami' });
  assert.match((api.data as any).value, /Alyan/);
});

test('file vault encrypts at rest (AES-256-GCM) and roundtrips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclicky-vault-'));
  const file = path.join(dir, 'vault.json');
  const v1 = new FileTokenVault(file, 'test-passphrase');
  v1.set('demo', { accessToken: 'sekret', obtainedAtMs: 1 });

  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('sekret'), 'token must not appear in plaintext on disk');

  const v2 = new FileTokenVault(file, 'test-passphrase');
  assert.equal(v2.get('demo')?.accessToken, 'sekret');

  const wrong = new FileTokenVault(file, 'wrong-passphrase');
  assert.equal(wrong.get('demo'), undefined, 'wrong key cannot decrypt');
  fs.rmSync(dir, { recursive: true, force: true });
});
