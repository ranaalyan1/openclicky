/**
 * HeyClicky compatibility: argument shapes, honest refusals, real dispatch.
 * A fake runtime records every invocation so nothing is assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEYCLICKY_SURFACE,
  HeyClickyCompat,
  heyclickyToolSchemas,
  normalizeCall,
  renderCompatDoc,
} from '../src/compat/heyclicky.js';
import { RuntimeRegistry } from '../src/registry.js';
import type { CapabilitySnapshot, CommandResult, InvokeCommand } from '../src/types.js';

class FakeRuntime {
  readonly runtimeId = 'fake';
  calls: InvokeCommand[] = [];
  async snapshot(): Promise<CapabilitySnapshot> {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'sandbox-browser',
      protocolVersion: '1',
      commands: [
        { id: 'web.navigate', version: 'v1', title: 'nav', description: 'nav', args: [], defaultApproval: 'AUTO' },
        { id: 'web.state', version: 'v1', title: 'state', description: 'state', args: [], defaultApproval: 'AUTO' },
        { id: 'web.click', version: 'v1', title: 'click', description: 'click', args: [], defaultApproval: 'ASK_ONCE' },
        { id: 'web.type', version: 'v1', title: 'type', description: 'type', args: [], defaultApproval: 'ASK_ALWAYS' },
        { id: 'web.search', version: 'v1', title: 'search', description: 'search', args: [], defaultApproval: 'AUTO' },
        { id: 'pc.a11y_tree', version: 'v1', title: 'a11y', description: 'a11y', args: [], defaultApproval: 'AUTO' },
      ],
      dataSources: [],
      triggers: [],
    };
  }
  async invoke(cmd: InvokeCommand): Promise<CommandResult> {
    this.calls.push(cmd);
    if (cmd.commandId === 'nonexistent') throw new Error('should not happen');
    const body = { title: 'Example', body: `ran ${cmd.commandId}` };
    return {
      invocationId: cmd.invocationId,
      ok: true,
      data: { kind: 'string', value: JSON.stringify(body) },
    };
  }
}

async function compatWithFake(): Promise<{ compat: HeyClickyCompat; fake: FakeRuntime }> {
  const registry = new RuntimeRegistry();
  const fake = new FakeRuntime();
  await registry.register(fake as any);
  return { compat: new HeyClickyCompat(registry), fake };
}

test('normalizeCall accepts both HeyClicky call shapes', () => {
  assert.deepEqual(normalizeCall({ action: 'open', url: 'https://a.example' }), {
    action: 'open',
    params: { url: 'https://a.example' },
  });
  assert.deepEqual(normalizeCall({ open: { url: 'https://a.example' } }), {
    action: 'open',
    params: { url: 'https://a.example' },
  });
  assert.deepEqual(normalizeCall({ tabs: true }), { action: 'tabs', params: {} });
});

test('browser/open drives web.navigate with the url', async () => {
  const { compat, fake } = await compatWithFake();
  const res = await compat.call('browser', { action: 'open', url: 'https://example.com' });
  assert.equal(res.ok, true);
  assert.equal(res.commandId, 'web.navigate');
  assert.match(res.text, /ran web\.navigate/);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args.url, { kind: 'string', value: 'https://example.com' });
  assert.equal(fake.calls[0].commandVersion, 'v1');
});

test('browser/single-key shape fills a field through web.type', async () => {
  const { compat, fake } = await compatWithFake();
  const res = await compat.call('browser', { fill: { ref: 3, text: 'hello' } });
  assert.equal(res.ok, true);
  assert.equal(fake.calls[0].commandId, 'web.type');
  assert.deepEqual(fake.calls[0].args.elementIndex, { kind: 'number', value: 3 });
  assert.deepEqual(fake.calls[0].args.text, { kind: 'string', value: 'hello' });
});

test('browser/search and snapshot map onto the reader and a11y tiers', async () => {
  const { compat, fake } = await compatWithFake();
  await compat.call('browser', { action: 'search', query: 'openai operator' });
  await compat.call('browser', { action: 'snapshot' });
  assert.deepEqual(fake.calls.map((c) => c.commandId), ['web.search', 'web.state']);
  assert.deepEqual(fake.calls[0].args.query, { kind: 'string', value: 'openai operator' });
});

test('absent actions refuse clearly, name an alternative, and never dispatch', async () => {
  const { compat, fake } = await compatWithFake();
  const res = await compat.call('browser', { action: 'javascript', code: 'return 1' });
  assert.equal(res.ok, false);
  assert.equal(res.unsupported, true);
  assert.match(res.text, /not in this build/);
  assert.match(res.text, /Do not retry/);
  assert.match(res.text, /open/, 'names what does work');
  assert.equal(fake.calls.length, 0, 'a phantom tool never reaches a runtime');
});

test('unknown tool actions list what is available', async () => {
  const { compat } = await compatWithFake();
  const res = await compat.call('browser', { action: 'teleport' });
  assert.equal(res.unsupported, true);
  assert.match(res.text, /Unknown browser action "teleport"/);
  assert.match(res.text, /snapshot/);
});

test('mac_step degrades to the a11y tree instead of pretending to act', async () => {
  const { compat, fake } = await compatWithFake();
  const res = await compat.call('mac_step', { action: 'inspect', instruction: 'export the sheet' });
  assert.equal(res.ok, true);
  assert.equal(res.commandId, 'pc.a11y_tree');
  assert.equal(fake.calls.length, 1);
});

test('a command with no connected runtime is refused, not attempted', async () => {
  const registry = new RuntimeRegistry(); // nothing registered
  const compat = new HeyClickyCompat(registry);
  const res = await compat.call('browser', { action: 'open', url: 'https://x.example' });
  assert.equal(res.ok, false);
  assert.equal(res.unsupported, true);
  assert.match(res.text, /Connect that device/);
});

test('only usable tools are advertised to a model', () => {
  const names = heyclickyToolSchemas().map((t) => t.function.name);
  assert.ok(names.includes('browser'));
  assert.ok(names.includes('mac_step'));
  assert.ok(!names.includes('sessions_spawn'), 'all-absent tools stay hidden');
  assert.ok(!names.includes('clicky_memory'));

  const browser = heyclickyToolSchemas().find((t) => t.function.name === 'browser')!;
  const props = browser.function.parameters as any;
  assert.ok(props.properties.action.enum.includes('snapshot'));
  assert.ok(!props.properties.action.enum.includes('javascript'), 'absent actions are not offered');
});

test('the surface table is complete enough to document itself', () => {
  const statuses = new Set(HEYCLICKY_SURFACE.flatMap((t) => t.actions.map((a) => a.status)));
  assert.deepEqual([...statuses].sort(), ['absent', 'degraded', 'implemented']);

  const doc = renderCompatDoc();
  assert.match(doc, /# HeyClicky compatibility/);
  assert.match(doc, /\| `open \{url\}` \| `web\.navigate` \| implemented \|/);
  assert.match(doc, /\| `javascript \{code\}` \| — \| absent \|/);
  for (const tool of HEYCLICKY_SURFACE) assert.ok(doc.includes(`## \`${tool.tool}\``), tool.tool);
});
