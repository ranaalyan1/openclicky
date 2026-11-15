/**
 * OpenClicky UI server — bridges the agent core to the Clicky-style panel.
 * Plain node:http, zero deps: static UI + REST + SSE.
 *
 * The UI subscribes to /api/events (SSE): assistant messages, command
 * results, and approval requests arrive live. Approvals resolve through
 * /api/approvals/:id — the HITL engine's ask-flow, but click to approve.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Agent, ExecutorEvents } from '@openclicky/core';
import type {
  ApprovalDecision,
  ApprovalRequest,
  SaveSettingsInput,
  SearchProvider,
  VoiceAdapter,
  VerifyResult,
} from '@openclicky/core';

/** The key is never returned; only a masked preview. */
export interface PublicSettings {
  baseUrl: string;
  model: string;
  vision: boolean;
  hasKey: boolean;
  keyPreview: string;
}

export interface SettingsAccess {
  read(): PublicSettings;
  write(update: SaveSettingsInput): PublicSettings;
}

interface SseClient extends http.ServerResponse {
  writeSse(event: string, data: unknown): void;
}

export interface PendingApproval {
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

/** Shared bus between the agent's events and the UI server. */
export interface UiBridge {
  pending: Map<string, PendingApproval>;
  broadcast(event: string, data: unknown): void;
}

export function createUiBridge(): UiBridge {
  const clients = new Set<SseClient>();
  return {
    pending: new Map(),
    broadcast(event, data) {
      for (const client of clients) client.writeSse(event, data);
    },
    /** @internal */ addClient(c: SseClient): void {
      clients.add(c);
    },
    /** @internal */ removeClient(c: SseClient): void {
      clients.delete(c);
    },
  } as UiBridge & { addClient(c: SseClient): void; removeClient(c: SseClient): void };
}

/** Wire the agent's executor events to the UI bridge. */
export function agentEventsFor(bridge: UiBridge): ExecutorEvents {
  return {
    onAssistantMessage(content) {
      if (content) bridge.broadcast('assistant', { content });
    },
    onCommandResult(ok, summary) {
      bridge.broadcast('result', { ok, summary });
    },
    onApprovalRequest(request) {
      return new Promise<ApprovalDecision>((resolve) => {
        bridge.pending.set(request.requestId, { request, resolve });
        bridge.broadcast('approval', request);
      });
    },
  };
}

export interface OpenClickyServerOptions {
  agent: Agent;
  webRoot: string;
  bridge: UiBridge;
  /**
   * When set, every /api/* request must carry `Authorization: Bearer <token>`.
   * Use when binding beyond loopback (OPENCLICKY_HOST) — approvals are as
   * powerful as the person at the keyboard.
   */
  authToken?: string;
  /** Voice: POST /api/voice (audio → transcribe → chat) and /api/speak (TTS). */
  audio?: VoiceAdapter;
  /** In-app model + search configuration (first-run onboarding + settings gear). */
  settings?: SettingsAccess;
  /**
   * Live key check used by the setup card's "Test keys" button. Optional so
   * tests can run without network access.
   */
  verify?: {
    model(input: { baseUrl: string; apiKey: string; model: string }): Promise<VerifyResult>;
    search(input: { apiKey: string }): Promise<VerifyResult>;
  };
}

export function createOpenClickyServer(opts: OpenClickyServerOptions): http.Server {
  const { agent, webRoot, bridge } = opts;
  const internalBridge = bridge as UiBridge & {
    addClient(c: SseClient): void;
    removeClient(c: SseClient): void;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      // Token gate: materialized approvals ride this API, so everything under
      // /api/* requires the bearer token when one is configured.
      if (opts.authToken && url.pathname.startsWith('/api/')) {
        if (req.headers.authorization !== `Bearer ${opts.authToken}`) {
          return json(res, 401, { error: 'unauthorized' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const client = res as SseClient;
        client.writeSse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        internalBridge.addClient(client);
        req.on('close', () => internalBridge.removeClient(client));
        client.writeSse('hello', { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/capabilities') {
        await agent.start();
        return json(res, 200, { capabilities: summarizeCapabilities(agent) });
      }

      if (req.method === 'GET' && url.pathname === '/api/pending') {
        return json(res, 200, {
          approvals: [...bridge.pending.values()].map((p) => p.request),
        });
      }

      // Voice in: raw audio bytes -> transcript -> routed through the agent.
      if (req.method === 'POST' && url.pathname === '/api/voice') {
        if (!opts.audio) return json(res, 503, { error: 'voice not configured (set OPENCLICKY_MODEL_KEY for an OpenAI-compatible audio endpoint)' });
        const audio = await readRaw(req, 10 * 1024 * 1024);
        const text = await opts.audio.transcribe(audio, req.headers['content-type'] ?? 'audio/webm');
        if (!text.trim()) return json(res, 200, { text: '', reply: '' });
        const reply = await agent.send(text);
        return json(res, 200, { text, reply });
      }

      // Voice out: text -> synthesized speech (audio/mpeg bytes).
      if (req.method === 'POST' && url.pathname === '/api/speak') {
        if (!opts.audio) return json(res, 503, { error: 'voice not configured' });
        const body = await readJson(req);
        const text = typeof body?.text === 'string' ? body.text : '';
        if (!text.trim()) return json(res, 400, { error: 'text required' });
        const audio = await opts.audio.speak(text);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
        res.end(audio);
        return;
      }

      // Model settings for the onboarding card / settings gear.
      if (url.pathname === '/api/settings') {
        if (!opts.settings) return json(res, 404, { error: 'settings not available' });
        if (req.method === 'GET') return json(res, 200, opts.settings.read());
        if (req.method === 'POST') {
          const body = await readJson(req);
          const update: SaveSettingsInput = {};
          if (body.baseUrl !== undefined) {
            if (typeof body.baseUrl !== 'string' || !/^https?:\/\//.test(body.baseUrl)) {
              return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
            }
            update.baseUrl = body.baseUrl.replace(/\/+$/, '');
          }
          if (body.model !== undefined) {
            if (typeof body.model !== 'string' || !body.model.trim()) return json(res, 400, { error: 'model must be a non-empty string' });
            update.model = body.model.trim();
          }
          if (body.apiKey !== undefined) {
            if (typeof body.apiKey !== 'string') return json(res, 400, { error: 'apiKey must be a string' });
            update.apiKey = body.apiKey.trim();
          }
          // KEY 2 · search — empty string is meaningful: it clears the key and
          // switches web.search back to the keyless DuckDuckGo fallback.
          if (body.searchApiKey !== undefined) {
            if (typeof body.searchApiKey !== 'string') return json(res, 400, { error: 'searchApiKey must be a string' });
            update.searchApiKey = body.searchApiKey.trim();
          }
          if (body.searchProvider !== undefined) {
            const allowed = ['auto', 'brave', 'duckduckgo'];
            if (typeof body.searchProvider !== 'string' || !allowed.includes(body.searchProvider)) {
              return json(res, 400, { error: `searchProvider must be one of ${allowed.join(', ')}` });
            }
            update.searchProvider = body.searchProvider as SearchProvider;
          }
          const next = opts.settings.write(update);
          bridge.broadcast('settings', next);
          return json(res, 200, next);
        }
        return json(res, 405, { error: 'method not allowed' });
      }

      // POST /api/settings/verify — ping both keys with what the user typed,
      // before anything is saved. Powers the "Test keys" button.
      if (url.pathname === '/api/settings/verify') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (!opts.verify) return json(res, 404, { error: 'verification not available' });
        const body = await readJson(req);
        const out: { model?: VerifyResult; search?: VerifyResult } = {};
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          out.model = await opts.verify.model({
            baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
            apiKey: body.apiKey,
            model: typeof body.model === 'string' ? body.model : '',
          });
        }
        if (typeof body.searchApiKey === 'string' && body.searchApiKey.trim()) {
          out.search = await opts.verify.search({ apiKey: body.searchApiKey });
        }
        return json(res, 200, out);
      }

      // POST /brain/turn — HeyClicky's own turn route, so a Clicky-style
      // client can point at OpenClicky unchanged. Transport shape is theirs
      // (SSE: `text` then `done`); the loop underneath is our executor, so
      // HITL approvals still go through /api/approvals and the SSE bridge.
      if (req.method === 'POST' && url.pathname === '/brain/turn') {
        const body = await readJson(req);
        const text = typeof body?.text === 'string' ? body.text : typeof body?.message === 'string' ? body.message : '';
        if (!text.trim()) return json(res, 400, { error: 'text required' });

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const emit = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        try {
          const reply = await agent.send(text);
          // One text event carrying the whole reply: the executor loop is
          // request/response, so we do not fake token-level streaming.
          emit('text', { text: reply });
          emit('done', { reply });
        } catch (err) {
          emit('error', { message: (err as Error).message });
        } finally {
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJson(req);
        const text = typeof body?.text === 'string' ? body.text : '';
        if (!text.trim()) return json(res, 400, { error: 'text required' });
        const reply = await agent.send(text);
        return json(res, 200, { reply });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/approvals/')) {
        const requestId = url.pathname.split('/')[3];
        const body = await readJson(req);
        const approval = bridge.pending.get(requestId);
        if (!approval) return json(res, 404, { error: 'no such approval request' });
        bridge.pending.delete(requestId);
        const approved = body?.approved === true;
        const decision: ApprovalDecision = {
          requestId,
          invocationId: approval.request.invocationId,
          approved,
          scope: body?.scope === 'always' ? `always:${approval.request.commandId}` : 'once',
          decidedBy: typeof body?.decidedBy === 'string' ? body.decidedBy : 'web-ui',
          decidedAtMs: Date.now(),
        };
        approval.resolve(decision);
        bridge.broadcast('approval:resolved', { requestId, approved, scope: decision.scope });
        return json(res, 200, { ok: true });
      }

      return serveStatic(url.pathname, res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  return server;

  function serveStatic(pathname: string, res: http.ServerResponse): void {
    const clean = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(webRoot, clean);
    if (!file.startsWith(webRoot)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) {
        fs.readFile(path.join(webRoot, 'index.html'), (err2, index) => {
          if (err2) return json(res, 404, { error: 'not found' });
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(index);
        });
        return;
      }
      res.writeHead(200, { 'content-type': mimeFor(file) });
      res.end(data);
    });
  }
}

function summarizeCapabilities(agent: Agent): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const msg of agent.history()) {
    if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('Connected runtimes:')) {
      for (const line of msg.content.split('\n').slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().split(',').map((s) => s.trim());
      }
    }
  }
  return out;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readRaw(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function mimeFor(file: string): string {
  return MIME[path.extname(file)] ?? 'application/octet-stream';
}
