import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, HitlEngine, summarizeArgs } from '../src/index.js';
import type { ModelAdapter, ChatMessage, ModelReply, ModelToolSchema } from '../src/model.js';
import type { Runtime } from '../src/registry.js';
import type { CapabilitySnapshot, CommandResult, InvokeCommand, ApprovalRequest, ApprovalDecision } from '../src/types.js';

/** Scripted model: first turn asks for a tool, second turn answers. */
class ScriptedModel implements ModelAdapter {
  public seen: ModelToolSchema[] = [];
  /** Snapshot of the message list from every chat() call. */
  public messageLog: ChatMessage[][] = [];
  private step = 0;
  constructor(private toolName: string, private finalText: string, private argsJson = '{}') {}

  async chat(messages: ChatMessage[], tools: ModelToolSchema[]): Promise<ModelReply> {
    this.seen = tools;
    this.messageLog.push(messages.map((m) => ({ ...m })));
    if (this.step++ === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'call-1', name: this.toolName, argumentsJson: this.argsJson }],
      };
    }
    return { content: this.finalText, toolCalls: [] };
  }
}

class EchoRuntime implements Runtime {
  readonly runtimeId = 'test-runtime';
  public invoked: InvokeCommand[] = [];

  async snapshot(): Promise<CapabilitySnapshot> {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'pc-host',
      protocolVersion: '1',
      commands: [
        {
          id: 'test.echo',
          version: 'v1',
          title: 'Echo',
          description: 'Echoes text back',
          args: [{ name: 'text', type: 'string', description: 'text', required: true }],
          defaultApproval: 'AUTO',
        },
        {
          id: 'test.danger',
          version: 'v1',
          title: 'Danger',
          description: 'A sensitive action that must ask first',
          args: [],
          defaultApproval: 'ASK_ALWAYS',
        },
        {
          id: 'test.choice',
          version: 'v1',
          title: 'Choice',
          description: 'Constrained input for argument validation tests',
          args: [{ name: 'mode', type: 'enum', description: 'mode', enumValues: ['a', 'b'], required: true }],
          defaultApproval: 'AUTO',
        },
      ],
      dataSources: [],
      triggers: [],
    };
  }

  async invoke(cmd: InvokeCommand): Promise<CommandResult> {
    this.invoked.push(cmd);
    return { invocationId: cmd.invocationId, ok: true, data: { kind: 'string', value: 'echo' } };
  }
}

test('agent runs a full tool loop and returns the final text', async () => {
  const runtime = new EchoRuntime();
  const agent = createAgent({
    model: new ScriptedModel('test.echo', 'done!', '{"text":"hello"}'),
    runtimes: [runtime],
  });
  await agent.start();
  const reply = await agent.send('say something');
  assert.equal(reply, 'done!');
  assert.equal(runtime.invoked.length, 1);
  assert.equal(runtime.invoked[0].commandId, 'test.echo');
});

test('unknown tools are reported to the model instead of crashing', async () => {
  const agent = createAgent({
    model: new ScriptedModel('test.does_not_exist', 'recovered'),
    runtimes: [new EchoRuntime()],
  });
  await agent.start();
  const reply = await agent.send('do a thing');
  assert.equal(reply, 'recovered');
});

test('ASK_ALWAYS commands pause for approval and run when approved', async () => {
  const runtime = new EchoRuntime();
  const requests: ApprovalRequest[] = [];
  const agent = createAgent({
    model: new ScriptedModel('test.danger', 'did it'),
    runtimes: [runtime],
    events: {
      onApprovalRequest: async (req) => {
        requests.push(req);
        const decision: ApprovalDecision = {
          requestId: req.requestId,
          invocationId: req.invocationId,
          approved: true,
          scope: 'once',
          decidedBy: 'tester',
          decidedAtMs: Date.now(),
        };
        return decision;
      },
    },
  });
  await agent.start();
  await agent.send('do the danger');
  assert.equal(requests.length, 1, 'approval was requested');
  assert.equal(requests[0].commandId, 'test.danger');
  assert.equal(runtime.invoked.length, 1);
  assert.equal(runtime.invoked[0].approvedBy, 'tester');
});

test('declined approvals block execution', async () => {
  const runtime = new EchoRuntime();
  const agent = createAgent({
    model: new ScriptedModel('test.danger', 'ok, I did not do it'),
    runtimes: [runtime],
    events: {
      onApprovalRequest: async (req) => ({
        requestId: req.requestId,
        invocationId: req.invocationId,
        approved: false,
        scope: 'once',
        decidedBy: 'tester',
        decidedAtMs: Date.now(),
      }),
    },
  });
  await agent.start();
  await agent.send('do the danger');
  assert.equal(runtime.invoked.length, 0, 'command must not run when declined');
});

test('sensitive args are redacted in approval summaries', () => {
  const summary = summarizeArgs({ password: { kind: 'string', value: 'hunter2' } });
  assert.equal(summary[0].sensitive, true);
  assert.notEqual(summary[0].preview, 'hunter2');
});

test('missing required args are reported to the model, not executed', async () => {
  const runtime = new EchoRuntime();
  const model = new ScriptedModel('test.echo', 'recovered'); // calls with '{}' — no text
  const agent = createAgent({ model, runtimes: [runtime] });
  await agent.start();
  const reply = await agent.send('echo something');
  assert.equal(reply, 'recovered');
  assert.equal(runtime.invoked.length, 0, 'invalid call must never reach the runtime');
  const toolMsg = model.messageLog[1].find((m) => m.role === 'tool');
  const content = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
  // content is JSON, so the quoted name is escaped — match on the phrases
  assert.match(content, /missing required argument/);
  assert.match(content, /text/);
});

test('out-of-enum args are rejected with the allowed values', async () => {
  const runtime = new EchoRuntime();
  const model = new ScriptedModel('test.choice', 'fixed', '{"mode":"zzz"}');
  const agent = createAgent({ model, runtimes: [runtime] });
  await agent.start();
  await agent.send('pick one');
  assert.equal(runtime.invoked.length, 0);
  const toolMsg = model.messageLog[1].find((m) => m.role === 'tool');
  assert.match(typeof toolMsg?.content === 'string' ? toolMsg.content : '', /must be one of: a, b/);
});

/** Runtime that answers with an image, like pc.screenshot does. */
class ShotRuntime implements Runtime {
  readonly runtimeId = 'shot-runtime';
  public invoked = 0;
  async snapshot(): Promise<CapabilitySnapshot> {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'pc-host',
      protocolVersion: '1',
      commands: [
        { id: 'test.shot', version: 'v1', title: 'Screenshot', description: 'Returns an image', args: [], defaultApproval: 'AUTO' },
      ],
      dataSources: [],
      triggers: [],
    };
  }
  async invoke(cmd: InvokeCommand): Promise<CommandResult> {
    this.invoked += 1;
    // base64 of "hello" — a stand-in for PNG bytes
    return { invocationId: cmd.invocationId, ok: true, data: { kind: 'image', value: 'aGVsbG8=' } };
  }
}

test('image results are attached as vision content parts for the next step', async () => {
  const model = new ScriptedModel('test.shot', 'i see it');
  const agent = createAgent({ model, runtimes: [new ShotRuntime()] });
  await agent.start();
  const reply = await agent.send('look at my screen');
  assert.equal(reply, 'i see it');
  const secondCall = model.messageLog[1];
  const imageMsg = secondCall.find((m) => m.role === 'user' && Array.isArray(m.content));
  assert.ok(imageMsg, 'a user message carrying the image must follow the tool results');
  const parts = imageMsg.content as { type: string; image_url?: { url: string } }[];
  const imagePart = parts.find((p) => p.type === 'image_url');
  assert.equal(imagePart?.image_url?.url, 'data:image/png;base64,aGVsbG8=');
  // Tool messages still precede the image, in order.
  const toolIdx = secondCall.findIndex((m) => m.role === 'tool');
  const imgIdx = secondCall.indexOf(imageMsg);
  assert.ok(toolIdx !== -1 && imgIdx > toolIdx, 'image part comes after the tool message');
});

test('vision: false keeps image results text-only', async () => {
  const model = new ScriptedModel('test.shot', 'done blind');
  const agent = createAgent({ model, runtimes: [new ShotRuntime()], vision: false });
  await agent.start();
  await agent.send('look at my screen');
  const secondCall = model.messageLog[1];
  assert.ok(!secondCall.some((m) => Array.isArray(m.content)), 'no image parts when vision is off');
  const toolMsg = secondCall.find((m) => m.role === 'tool');
  assert.match(typeof toolMsg?.content === 'string' ? toolMsg.content : '', /vision disabled/);
});

/** Multi-step scripted model: replays a planned see→act→verify session. */
class SequenceModel implements ModelAdapter {
  public messageLog: ChatMessage[][] = [];
  private i = 0;
  constructor(private steps: ({ tool: { name: string; argsJson?: string } } | { text: string })[]) {}
  async chat(messages: ChatMessage[], _tools: ModelToolSchema[]): Promise<ModelReply> {
    this.messageLog.push(messages.map((m) => ({ ...m })));
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)];
    if ('text' in step) return { content: step.text, toolCalls: [] };
    return { content: '', toolCalls: [{ id: `c${this.i}`, name: step.tool.name, argumentsJson: step.tool.argsJson ?? '{}' }] };
  }
}

test('pc agent session: sees the screen, launches an app, types, verifies (with HITL)', async () => {
  const { FakeDriver } = await import('../src/runtimes/pc-drivers.js');
  const { PcHostRuntime } = await import('../src/runtimes/pc-host.js');
  const driver = new FakeDriver();
  const approvals: string[] = [];
  const model = new SequenceModel([
    { tool: { name: 'pc.screen_info' } },
    { tool: { name: 'pc.screenshot' } },
    { tool: { name: 'pc.launch_app', argsJson: '{"appId":"notepad"}' } },
    { tool: { name: 'pc.type_text', argsJson: '{"text":"hello openclicky"}' } },
    { tool: { name: 'pc.screenshot' } },
    { text: 'Opened Notepad, typed the text, and re-screenshotted to verify.' },
  ]);
  const agent = createAgent({
    model,
    runtimes: [new PcHostRuntime({ driver })],
    events: {
      onApprovalRequest: async (req) => {
        approvals.push(req.commandId);
        return {
          requestId: req.requestId,
          invocationId: req.invocationId,
          approved: true,
          scope: req.commandId === 'pc.launch_app' ? `always:${req.commandId}` : 'once',
          decidedBy: 'tester',
          decidedAtMs: Date.now(),
        };
      },
    },
  });
  await agent.start();
  const reply = await agent.send('open notepad and type hello openclicky');

  assert.match(reply, /verify/);
  // The driver saw the exact sequence of native operations, in order.
  assert.deepEqual(
    driver.calls.map((c) => c.op),
    ['screenInfo', 'screenshot', 'launchApp', 'typeText', 'screenshot'],
  );
  // AUTO commands ran silently; actuation commands asked first.
  assert.deepEqual(approvals, ['pc.launch_app', 'pc.type_text']);
  // Screenshots were attached as vision parts the model could see on later steps.
  const sawImage = model.messageLog.some((msgs) => msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')));
  assert.ok(sawImage, 'screenshot image parts reached the model');
});

/** Model that just reports the last user message — used to observe triggers. */
class TriggerProbeModel implements ModelAdapter {
  public turns: ChatMessage[][] = [];
  async chat(messages: ChatMessage[], _tools: ModelToolSchema[]): Promise<ModelReply> {
    this.turns.push(messages.map((m) => ({ ...m })));
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return { content: `awake: ${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 60) : ''}`, toolCalls: [] };
  }
}

async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

test('a hotkey press wakes the agent with a trigger turn (Muse proactive pattern)', async () => {
  const { FakeDriver } = await import('../src/runtimes/pc-drivers.js');
  const { PcHostRuntime } = await import('../src/runtimes/pc-host.js');
  const driver = new FakeDriver();
  const pc = new PcHostRuntime({ driver });
  const model = new TriggerProbeModel();
  const agent = createAgent({ model, runtimes: [pc] });
  await agent.start();

  await pc.invoke({ invocationId: 't1', commandId: 'pc.hotkey.listen', commandVersion: 'v1', args: { chord: { kind: 'string', value: 'ctrl+alt+k' } } });
  assert.ok(driver.calls.some((c) => c.op === 'watchHotkey'));

  driver.fireHotkey('ctrl+alt+k');
  const woke = await until(() =>
    model.turns.some((turn) => turn.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('A device event fired: pc.hotkey'))),
  );
  await pc.dispose();
  assert.ok(woke, 'pressing the hotkey produced a trigger turn for the model');
});

test('a file change wakes the agent (pc.files.watch)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { PcHostRuntime } = await import('../src/runtimes/pc-host.js');
  const { FakeDriver } = await import('../src/runtimes/pc-drivers.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclicky-watch-'));
  const pc = new PcHostRuntime({ driver: new FakeDriver() });
  const model = new TriggerProbeModel();
  const agent = createAgent({ model, runtimes: [pc] });
  await agent.start();

  await pc.invoke({ invocationId: 't2', commandId: 'pc.files.watch', commandVersion: 'v1', args: { path: { kind: 'string', value: dir } } });
  await new Promise((r) => setTimeout(r, 100)); // let the watcher arm
  fs.writeFileSync(path.join(dir, 'changed.txt'), 'hello');

  const woke = await until(() =>
    model.turns.some((turn) => turn.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('A device event fired: pc.files.watch'))),
  );
  await pc.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(woke, 'the file write produced a trigger turn for the model');
});

test('hitl gate honors prior always-grants for ASK_ONCE', async () => {
  const runtime = new EchoRuntime();
  const engine = new HitlEngine();
  // Pre-grant a once-command.
  const snap = await runtime.snapshot();
  const once = { ...snap.commands[0], id: 'test.once', defaultApproval: 'ASK_ONCE' as const };
  const verdict = engine.gate(once, 'inv-1', {});
  assert.equal(verdict.action, 'ask');
  if (verdict.action === 'ask') {
    engine.record('test.once', {
      requestId: verdict.request.requestId,
      invocationId: 'inv-1',
      approved: true,
      scope: 'always:test.once',
      decidedBy: 'tester',
      decidedAtMs: Date.now(),
    });
  }
  const again = engine.gate(once, 'inv-2', {});
  assert.equal(again.action, 'run');
});
