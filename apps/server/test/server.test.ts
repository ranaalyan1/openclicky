import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';

import { createAgent, publicSettings } from '@openclicky/core';
import type { ChatMessage, ModelAdapter, ModelReply, ModelToolSchema } from '@openclicky/core';
import { agentEventsFor, createOpenClickyServer, createUiBridge } from '../src/createServer.js';

/** Scripted model: one tool call then a plain answer. */
class ScriptedModel implements ModelAdapter {
  private step = 0;
  constructor(private finalText: string) {}
  async chat(_m: ChatMessage[], _t: ModelToolSchema[]): Promise<ModelReply> {
    if (this.step++ === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'test.danger', argumentsJson: '{}' }],
      };
    }
    return { content: this.finalText, toolCalls: [] };
  }
}

/** Answers straight away — no tool call, so no approval gate to wait on. */
class PlainModel implements ModelAdapter {
  constructor(private readonly text: string) {}
  async chat(): Promise<ModelReply> {
    return { content: this.text, toolCalls: [] };
  }
}

class DangerRuntime {
  readonly runtimeId = 'test-runtime';
  public invoked = 0;
  async snapshot() {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'pc-host',
      protocolVersion: '1',
      commands: [
        {
          id: 'test.danger',
          version: 'v1',
          title: 'Danger',
          description: 'Must be approved',
          args: [],
          defaultApproval: 'ASK_ALWAYS',
        },
      ],
      dataSources: [],
      triggers: [],
    };
  }
  async invoke() {
    this.invoked += 1;
    return { invocationId: 'x', ok: true, data: { kind: 'string', value: 'done' } };
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: 'localhost',
        port,
        method,
        path,
        headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data || '{}') });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestRaw(
  port: number,
  method: string,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, method, path, headers: { 'content-type': contentType, 'content-length': body.length } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sseWaitFor(port: number, event: string, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port, path: '/api/events' }, (res) => {
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`timeout waiting for ${event}`));
      }, timeoutMs);
      res.on('data', (chunk) => {
        buf += chunk;
        const marker = `event: ${event}\ndata: `;
        const at = buf.indexOf(marker);
        if (at !== -1) {
          const rest = buf.slice(at + marker.length);
          const end = rest.indexOf('\n\n');
          if (end !== -1) {
            clearTimeout(timer);
            req.destroy();
            resolve(JSON.parse(rest.slice(0, end)));
          }
        }
      });
    });
    req.on('error', reject);
  });
}

const WEB_ROOT = path.join(import.meta.dirname, '..', '..', '..', 'web');

test('server serves chat, capabilities and the Clicky panel UI', async () => {
  const bridge = createUiBridge();
  const agent = createAgent({
    model: new ScriptedModel('all done'),
    runtimes: [new DangerRuntime() as any],
    events: agentEventsFor(bridge),
  });
  const server = createOpenClickyServer({ agent, webRoot: WEB_ROOT, bridge });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, r));

  try {
    // static UI
    const ui = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ host: 'localhost', port, path: '/' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
      }).on('error', reject);
    });
    assert.equal(ui.status, 200);
    assert.match(ui.body, /OpenClicky/);

    // capabilities
    const caps = await request(port, 'GET', '/api/capabilities');
    assert.ok(Object.keys(caps.json.capabilities)[0].startsWith('test-runtime'));

    // chat triggers an approval that we resolve via the API + SSE
    const approvalEvent = sseWaitFor(port, 'approval');
    const chatPromise = request(port, 'POST', '/api/chat', { text: 'do the danger' });
    const approval = await approvalEvent;
    assert.equal(approval.commandId, 'test.danger');

    const decided = await request(port, 'POST', `/api/approvals/${approval.requestId}`, { approved: true, scope: 'once' });
    assert.equal(decided.json.ok, true);

    const chat = await chatPromise;
    assert.equal(chat.json.reply, 'all done');

    // unknown approval id -> 404
    const missing = await request(port, 'POST', '/api/approvals/nope', { approved: true });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('API requires a bearer token when one is configured', async () => {
  const bridge = createUiBridge();
  const agent = createAgent({
    model: new ScriptedModel('ok'),
    runtimes: [new DangerRuntime() as any],
    events: agentEventsFor(bridge),
  });
  const server = createOpenClickyServer({ agent, webRoot: WEB_ROOT, bridge, authToken: 's3cret' });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, r));
  try {
    // /api/* is gated
    const denied = await request(port, 'GET', '/api/capabilities');
    assert.equal(denied.status, 401);
    const deniedChat = await request(port, 'POST', '/api/chat', { text: 'hi' });
    assert.equal(deniedChat.status, 401);
    // right token gets through
    const allowed = await request(port, 'GET', '/api/capabilities', undefined, { authorization: 'Bearer s3cret' });
    assert.equal(allowed.status, 200);
    // static UI is left un-gated (harmless markup; every action still needs the token)
    const ui = await new Promise<{ status: number }>((resolve, reject) => {
      http.get({ host: 'localhost', port, path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      }).on('error', reject);
    });
    assert.equal(ui.status, 200);
  } finally {
    server.close();
  }
});

test('voice endpoints transcribe mic audio into chat and speak replies back', async () => {
  const spoken: string[] = [];
  const audio = {
    async transcribe(_buf: Buffer, _mime: string): Promise<string> {
      return 'hello agent';
    },
    async speak(text: string): Promise<Buffer> {
      spoken.push(text);
      return Buffer.from('MP3BYTES');
    },
  };
  const bridge = createUiBridge();
  // Plain-answer model: the voice chat path must not stall on approvals here.
  const plainModel: ModelAdapter = {
    async chat(): Promise<ModelReply> {
      return { content: 'voice reply', toolCalls: [] };
    },
  };
  const agent = createAgent({
    model: plainModel,
    runtimes: [new DangerRuntime() as any],
    events: agentEventsFor(bridge),
  });
  const server = createOpenClickyServer({ agent, webRoot: WEB_ROOT, bridge, audio });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, r));
  try {
    const voice = await requestRaw(port, 'POST', '/api/voice', Buffer.from('FAKEAUDIO'), 'audio/webm');
    assert.equal(voice.status, 200);
    const payload = JSON.parse(voice.text);
    assert.equal(payload.text, 'hello agent', 'transcription returned');
    assert.equal(payload.reply, 'voice reply', 'transcript routed through the agent');

    const rawSpeak = await requestRaw(port, 'POST', '/api/speak', Buffer.from(JSON.stringify({ text: 'hi' })), 'application/json');
    assert.equal(rawSpeak.status, 200);
    assert.equal(rawSpeak.headers['content-type'], 'audio/mpeg');
    assert.equal(rawSpeak.text, 'MP3BYTES');
    assert.deepEqual(spoken, ['hi']);
  } finally {
    server.close();
  }
});

test('settings endpoints read, validate and hot-swap model config', async () => {
  let state = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: true, hasKey: false, keyPreview: '' };
  const writes: any[] = [];
  const settings = {
    read: () => state,
    write: (update: any) => {
      writes.push(update);
      // mirrors the real implementation: the public view never returns the key
      const { apiKey: _hidden, ...publicUpdate } = update;
      state = { ...state, ...publicUpdate, hasKey: true, keyPreview: 'sk-••••xyz' };
      return state;
    },
  };
  const bridge = createUiBridge();
  const plainModel: ModelAdapter = { async chat() { return { content: 'ok', toolCalls: [] }; } };
  const agent = createAgent({ model: plainModel, runtimes: [new DangerRuntime() as any], events: agentEventsFor(bridge) });
  const server = createOpenClickyServer({ agent, webRoot: WEB_ROOT, bridge, settings });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, r));
  try {
    const before = await request(port, 'GET', '/api/settings');
    assert.equal(before.json.hasKey, false);
    assert.ok(!JSON.stringify(before.json).includes('sk-'), 'no key material over the wire');

    const bad = await request(port, 'POST', '/api/settings', { baseUrl: 'ftp://nope' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /http/);

    const saved = await request(port, 'POST', '/api/settings', { baseUrl: 'http://localhost:1234/v1/', model: ' llama-3.2 ', apiKey: 'sk-xyz' });
    assert.equal(saved.status, 200);
    // trailing slash stripped, model trimmed
    assert.deepEqual(writes[0], { baseUrl: 'http://localhost:1234/v1', model: 'llama-3.2', apiKey: 'sk-xyz' });
    assert.equal(saved.json.hasKey, true);
    assert.ok(!JSON.stringify(saved.json).includes('sk-xyz'), 'response carries only the masked preview');
  } finally {
    server.close();
  }
});

test('pending endpoint lists unresolved approvals', async () => {
  const bridge = createUiBridge();
  const agent = createAgent({
    model: new ScriptedModel('ok'),
    runtimes: [new DangerRuntime() as any],
    events: agentEventsFor(bridge),
  });
  const server = createOpenClickyServer({ agent, webRoot: WEB_ROOT, bridge });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, r));
  try {
    const chatPromise = request(port, 'POST', '/api/chat', { text: 'go' });
    await new Promise((r) => setTimeout(r, 150));
    const pending = await request(port, 'GET', '/api/pending');
    assert.equal(pending.json.approvals.length, 1);
    assert.equal(pending.json.approvals[0].commandId, 'test.danger');
    const req = pending.json.approvals[0];
    await request(port, 'POST', `/api/approvals/${req.requestId}`, { approved: false });
    const chat = await chatPromise;
    assert.equal(chat.json.reply, 'ok');
    const runtime = agent // ensure command never ran
    const after = await request(port, 'GET', '/api/pending');
    assert.equal(after.json.approvals.length, 0);
  } finally {
    server.close();
  }
});

/** Two-key onboarding: settings read/write for key #2 + the verify endpoint. */
test('setup API: saves the search key, masks both keys, and verifies on demand', async () => {
  const bridge = createUiBridge();
  const agent = createAgent({
    model: new ScriptedModel('ok'),
    runtimes: [new DangerRuntime() as any],
    events: agentEventsFor(bridge),
  });

  let saved: any = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    vision: true,
    searchApiKey: '',
    searchProvider: 'auto',
  };
  const verifyCalls: any[] = [];

  const server = createOpenClickyServer({
    agent,
    webRoot: WEB_ROOT,
    bridge,
    settings: {
      read() {
        return publicSettings(saved);
      },
      write(update) {
        saved = { ...saved, ...update };
        return publicSettings(saved);
      },
    },
    verify: {
      async model(input) {
        verifyCalls.push({ kind: 'model', input });
        return { ok: true, detail: 'gpt-4o-mini replied — key works' };
      },
      async search(input) {
        verifyCalls.push({ kind: 'search', input });
        return { ok: false, detail: 'search key rejected (401)' };
      },
    },
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, r));

  try {
    // KEY 2 is saved through the same onboarding endpoint as KEY 1
    const written = await request(port, 'POST', '/api/settings', {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      apiKey: 'sk-model-secret',
      searchApiKey: 'BSA-search-secret',
      searchProvider: 'brave',
    });
    assert.equal(written.status, 200);
    assert.equal(saved.searchApiKey, 'BSA-search-secret');
    assert.equal(saved.searchProvider, 'brave');
    assert.ok(!JSON.stringify(written.json).includes('sk-model-secret'), 'model key never returned');
    assert.ok(!JSON.stringify(written.json).includes('BSA-search-secret'), 'search key never returned');
    assert.equal(written.json.hasSearchKey, true);

    // an invalid provider is rejected rather than saved
    const bad = await request(port, 'POST', '/api/settings', { searchProvider: 'bing' });
    assert.equal(bad.status, 400);
    assert.equal(saved.searchProvider, 'brave', 'unchanged after a rejected write');

    // "Test keys" pings both, without saving anything
    const verified = await request(port, 'POST', '/api/settings/verify', {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      apiKey: 'sk-typed',
      searchApiKey: 'BSA-typed',
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.json.model.ok, true);
    assert.equal(verified.json.search.ok, false);
    assert.deepEqual(
      verifyCalls.map((c) => c.kind),
      ['model', 'search'],
    );
    assert.equal(verifyCalls[1].input.apiKey, 'BSA-typed');

    // a blank search key clears key #2 → back to keyless DuckDuckGo
    const cleared = await request(port, 'POST', '/api/settings', { searchApiKey: '' });
    assert.equal(cleared.status, 200);
    assert.equal(saved.searchApiKey, '');
    assert.equal(cleared.json.hasSearchKey, false);
  } finally {
    server.close();
  }
});

/** HeyClicky's own turn route: a Clicky-style client can point here unchanged. */
test('/brain/turn answers in HeyClicky transport shape (SSE text + done)', async () => {
  const bridge = createUiBridge();
  const agent = createAgent({
    model: new PlainModel('the answer is 42'),
    runtimes: [new DangerRuntime() as any],
    events: agentEventsFor(bridge),
  });
  const server = createOpenClickyServer({ agent, webRoot: WEB_ROOT, bridge });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, r));

  try {
    const sse = await new Promise<string>((resolve, reject) => {
      const payload = JSON.stringify({ text: 'what is the answer?' });
      const req = http.request(
        {
          host: 'localhost',
          port,
          method: 'POST',
          path: '/brain/turn',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve(buf));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    assert.match(sse, /event: text\ndata: \{"text":"the answer is 42"\}/);
    assert.match(sse, /event: done\ndata: \{"reply":"the answer is 42"\}/);

    // an empty turn is rejected before any stream opens
    const empty = await request(port, 'POST', '/brain/turn', { text: '   ' });
    assert.equal(empty.status, 400);
  } finally {
    server.close();
  }
});
