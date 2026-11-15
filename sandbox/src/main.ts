/**
 * Sandbox browser worker — a disposable process that speaks the OpenClicky
 * protocol (JSON lines over stdio; the container image runs this).
 *
 * Inbound lines:  { "id": "...", "method": "snapshot"|"invoke"|"control", "params": {...} }
 * Outbound lines: { "id": "...", "result": {...} } | { "id": "...", "error": "..." }
 *                 { "event": "frame", "frame": StreamFrame }   (live view)
 *
 * The core bridges this worker to the planner via
 * BrowserSandboxRuntime({ actor }) (see apps/server wiring). Running it as a
 * container keeps untrusted web content off the host (Grok Bot isolation).
 */

import * as readline from 'node:readline';
import { BrowserSandboxRuntime } from '@openclicky/core';
import type { ControlCommand, InvokeCommand, StreamFrame } from '@openclicky/core';
import { PlaywrightActor } from './actor-playwright.js';

interface RpcRequest {
  id: string;
  method: 'snapshot' | 'invoke' | 'control';
  params?: unknown;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<void> {
  const actor = new PlaywrightActor({
    headful: process.env.OPENCLICKY_SANDBOX_HEADFUL === '1',
    startUrl: process.env.OPENCLICKY_SANDBOX_HOME ?? 'about:blank',
  });

  const runtime = new BrowserSandboxRuntime({
    actor,
    events: {
      onFrame(frame: StreamFrame) {
        send({ event: 'frame', frame });
      },
    },
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      send({ id: '?', error: 'bad json' });
      continue;
    }
    try {
      switch (req.method) {
        case 'snapshot':
          send({ id: req.id, result: await runtime.snapshot() });
          break;
        case 'invoke':
          send({ id: req.id, result: await runtime.invoke(req.params as InvokeCommand) });
          break;
        case 'control':
          await runtime.control(req.params as ControlCommand);
          send({ id: req.id, result: { ok: true } });
          break;
        default:
          send({ id: req.id, error: `unknown method: ${(req as RpcRequest).method}` });
      }
    } catch (err) {
      send({ id: req.id, error: (err as Error).message });
    }
  }
}

main().catch((err) => {
  send({ error: `fatal: ${(err as Error).message}` });
  process.exit(1);
});
