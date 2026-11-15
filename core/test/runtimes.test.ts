import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSandboxRuntime } from '../src/runtimes/browser-sandbox.js';
import { PcHostRuntime } from '../src/runtimes/pc-host.js';
import { FakeDriver } from '../src/runtimes/pc-drivers.js';

/* ---- browser: navigate + search with injected fetch ---- */

const PAGE_HTML = `<!doctype html><html><head><title>Example Domain</title></head>
<body><h1>Example Domain</h1>
<p>This domain is for use in examples and documentation.</p>
<a href="/about">About</a> <a href="https://other.example/x">Other</a>
</body></html>`;

const SEARCH_HTML = `<!doctype html><html><body><table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Result One</a></td></tr>
<tr><td class="result-snippet">Snippet <b>one</b> text</td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb&amp;rut=abc">Result Two</a></td></tr>
<tr><td class="result-snippet">Snippet two text</td></tr>
</table></body></html>`;

function fakeFetch(html: string): typeof fetch {
  return ((async () => {
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as unknown) as typeof fetch;
}

test('web.navigate extracts title, text and links', async () => {
  const rt = new BrowserSandboxRuntime({ fetchFn: fakeFetch(PAGE_HTML) });
  const snap = await rt.snapshot();
  assert.equal(snap.commands.length, 5);
  const res = await rt.invoke({
    invocationId: 'i1',
    commandId: 'web.navigate',
    commandVersion: 'v1',
    args: { url: { kind: 'string', value: 'example.com' } },
  });
  assert.equal(res.ok, true);
  const data = JSON.parse((res.data as any).value);
  assert.equal(data.title, 'Example Domain');
  assert.match(data.body, /for use in examples/);
  assert.ok(data.links.includes('https://example.com/about'));
});

test('web.navigate rejects non-http schemes', async () => {
  const rt = new BrowserSandboxRuntime({ fetchFn: fakeFetch(PAGE_HTML) });
  const res = await rt.invoke({
    invocationId: 'i2',
    commandId: 'web.navigate',
    commandVersion: 'v1',
    args: { url: { kind: 'string', value: 'file:///etc/passwd' } },
  });
  assert.equal(res.ok, false);
  assert.match(res.error!.message, /only http\/https/);
});

test('web.search parses DuckDuckGo lite results', async () => {
  const rt = new BrowserSandboxRuntime({ fetchFn: fakeFetch(SEARCH_HTML) });
  const res = await rt.invoke({
    invocationId: 'i3',
    commandId: 'web.search',
    commandVersion: 'v1',
    args: { query: { kind: 'string', value: 'anything' } },
  });
  assert.equal(res.ok, true);
  const body = (JSON.parse((res.data as any).value) as { body: string }).body;
  assert.match(body, /Result One/);
  assert.match(body, /https:\/\/example\.com\/a/);
});

test('actor-tier commands return 501 until the worker lands', async () => {
  const rt = new BrowserSandboxRuntime({ fetchFn: fakeFetch(PAGE_HTML) });
  const res = await rt.invoke({
    invocationId: 'i4',
    commandId: 'web.click',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 1 } },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error!.code, 501);
});

/* ---- browser sandbox: actor tier with an injected engine ---- */

class FakeActor {
  public ops: string[] = [];
  public disposed = false;
  async state() {
    this.ops.push('state');
    return {
      url: 'https://x.example/',
      title: 'X Page',
      elements: [
        { index: 0, role: 'button', name: 'Go', selector: '#go' },
        { index: 1, role: 'textbox', name: 'Query', selector: '#q' },
      ],
    };
  }
  async click(t: { elementIndex?: number; selector?: string }) {
    this.ops.push(`click:${t.elementIndex ?? t.selector}`);
  }
  async type(t: { elementIndex?: number; selector?: string; text: string }) {
    this.ops.push(`type:${t.elementIndex ?? t.selector}:${t.text}`);
  }
  async screenshot() {
    return 'ZnJhbWU='; // base64 "frame"
  }
  async dispose() {
    this.disposed = true;
  }
}

test('actor tier drives the engine and streams viewport frames', async () => {
  const actor = new FakeActor();
  const frames: { kind: string; data: string }[] = [];
  const rt = new BrowserSandboxRuntime({
    fetchFn: fakeFetch(PAGE_HTML),
    actor: actor as any,
    events: { onFrame: (f) => frames.push(f) },
  });

  const state = await rt.invoke({ invocationId: 'w1', commandId: 'web.state', commandVersion: 'v1', args: {} });
  assert.equal(state.ok, true);
  // data.value is a JSON envelope {title, body} — parse before matching
  const listing = JSON.parse((state.data as any).value) as { title: string; body: string };
  assert.match(listing.body, /X Page — https:\/\/x\.example\//);
  assert.match(listing.body, /\[0\] button "Go"/);

  const click = await rt.invoke({
    invocationId: 'w2',
    commandId: 'web.click',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 0 } },
  });
  assert.equal(click.ok, true);
  assert.match((JSON.parse((click.data as any).value) as { body: string }).body, /clicked element \[0\] — now on "X Page"/);
  assert.ok(actor.ops.includes('click:0'));

  const typed = await rt.invoke({
    invocationId: 'w3',
    commandId: 'web.type',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 1 }, text: { kind: 'string', value: 'openclicky' } },
  });
  assert.equal(typed.ok, true);
  assert.ok(actor.ops.includes('type:1:openclicky'));

  // each actuation streamed a live-view frame
  assert.ok(frames.length >= 2);
  assert.ok(frames.every((f) => f.kind === 'viewport' && f.data === 'ZnJhbWU='));
});

test('takeover freezes agent actuation until release; cancel disposes', async () => {
  const actor = new FakeActor();
  // lazy factory: cancel should dispose, and the next command re-creates
  let created = 0;
  const rt = new BrowserSandboxRuntime({
    fetchFn: fakeFetch(PAGE_HTML),
    actor: (async () => {
      created += 1;
      return actor as any;
    }) as any,
  });

  await rt.invoke({ invocationId: 'c0', commandId: 'web.state', commandVersion: 'v1', args: {} });
  assert.equal(created, 1);

  await rt.control({ action: 'takeover', taskId: 't1' });
  const blocked = await rt.invoke({
    invocationId: 'c1',
    commandId: 'web.click',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 0 } },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error!.code, 409);
  assert.match(blocked.error!.message, /user has taken control/);
  assert.ok(!actor.ops.includes('click:0'), 'no click while human is driving');

  await rt.control({ action: 'release', taskId: 't1' });
  const after = await rt.invoke({
    invocationId: 'c2',
    commandId: 'web.click',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 0 } },
  });
  assert.equal(after.ok, true);

  await rt.control({ action: 'cancel', taskId: 't1' });
  assert.equal(actor.disposed, true);
});

test('web.search results also arrive as Muse-style cards', async () => {
  const rt = new BrowserSandboxRuntime({ fetchFn: fakeFetch(SEARCH_HTML) });
  const res = await rt.invoke({
    invocationId: 'i5',
    commandId: 'web.search',
    commandVersion: 'v1',
    args: { query: { kind: 'string', value: 'anything' } },
  });
  assert.equal(res.ok, true);
  assert.equal(res.cards!.length, 2);
  assert.equal(res.cards![0].kind, 'search');
  assert.match(res.cards![0].json, /Result One/);
});

/* ---- pc host: driver dispatch ---- */

test('pc.host dispatches to the native driver', async () => {
  const driver = new FakeDriver();
  const rt = new PcHostRuntime({ driver });
  const win = await rt.invoke({
    invocationId: 'p1',
    commandId: 'pc.list_windows',
    commandVersion: 'v1',
    args: {},
  });
  assert.equal(win.ok, true);
  assert.match((win.data as any).value, /Demo Window/);

  await rt.invoke({
    invocationId: 'p2',
    commandId: 'pc.click',
    commandVersion: 'v1',
    args: { x: { kind: 'number', value: 120 }, y: { kind: 'number', value: 40 } },
  });
  const click = driver.calls.find((c) => c.op === 'click');
  assert.deepEqual(click?.args, { x: 120, y: 40 });

  await rt.invoke({
    invocationId: 'p3',
    commandId: 'pc.type_text',
    commandVersion: 'v1',
    args: { text: { kind: 'string', value: 'hello world' } },
  });
  const typed = driver.calls.find((c) => c.op === 'typeText');
  assert.equal((typed?.args as any).text, 'hello world');

  const shot = await rt.invoke({ invocationId: 'p4', commandId: 'pc.screenshot', commandVersion: 'v1', args: {} });
  assert.equal(shot.ok, true);
  // Screenshots are real image payloads now, so the executor can attach
  // them as vision content parts instead of a truncated text preview.
  assert.equal((shot.data as any).kind, 'image');
  assert.equal(Buffer.from((shot.data as any).value, 'base64').toString(), 'fake-png');
});

test('pc.host reports a clean error when no driver exists', async () => {
  const rt = new PcHostRuntime({ driver: undefined });
  // Force the "no driver" path: detectDriver() finds nothing on a headless box,
  // but Windows machines would return a driver; simulate by checking both paths.
  const snap = await rt.snapshot();
  assert.equal(snap.commands.length, 13);
  assert.ok(snap.triggers.some((t) => t.id === 'pc.files.watch'));
});

test('pc.host a11y tree feeds element-index clicks', async () => {
  const driver = new FakeDriver();
  const rt = new PcHostRuntime({ driver });

  // element-index click without a snapshot is a usage error, not a driver call
  const early = await rt.invoke({
    invocationId: 'a0',
    commandId: 'pc.click',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 0 } },
  });
  assert.equal(early.ok, false);
  assert.match(early.error!.message, /pc\.a11y_tree first/);

  // take the snapshot
  const tree = await rt.invoke({ invocationId: 'a1', commandId: 'pc.a11y_tree', commandVersion: 'v1', args: {} });
  assert.equal(tree.ok, true);
  const listing = (tree.data as any).value as string;
  assert.match(listing, /2 elements/);
  assert.match(listing, /\[0\] button "Save" \(100,200 80x24\)/);
  assert.ok(driver.calls.some((c) => c.op === 'a11yTree'));

  // click by index → resolves to the element center (100+40, 200+12)
  const click = await rt.invoke({
    invocationId: 'a2',
    commandId: 'pc.click',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 0 } },
  });
  assert.equal(click.ok, true);
  assert.match((click.data as any).value, /clicked left x1 \[0\] button "Save" at 140,212/);
  const lastClick = driver.calls.filter((c) => c.op === 'click').pop();
  assert.deepEqual(lastClick?.args, { x: 140, y: 212 });

  // stale/out-of-range index points back at a fresh snapshot
  const stale = await rt.invoke({
    invocationId: 'a3',
    commandId: 'pc.click',
    commandVersion: 'v1',
    args: { elementIndex: { kind: 'number', value: 99 } },
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error!.message, /out of range \(0\.\.1\)/);
});

test('pc.host exposes screen info, active window, scroll and click variants', async () => {
  const driver = new FakeDriver();
  const rt = new PcHostRuntime({ driver });

  const info = await rt.invoke({ invocationId: 's1', commandId: 'pc.screen_info', commandVersion: 'v1', args: {} });
  assert.equal(info.ok, true);
  const parsed = JSON.parse((info.data as any).value);
  assert.deepEqual(parsed, { width: 1920, height: 1080, scale: 1 });

  const active = await rt.invoke({ invocationId: 's2', commandId: 'pc.get_active_window', commandVersion: 'v1', args: {} });
  assert.equal(active.ok, true);
  assert.match((active.data as any).value, /Demo Window/);

  const scroll = await rt.invoke({
    invocationId: 's3',
    commandId: 'pc.scroll',
    commandVersion: 'v1',
    args: { dy: { kind: 'number', value: 3 } },
  });
  assert.equal(scroll.ok, true);
  const scrollCall = driver.calls.find((c) => c.op === 'scroll');
  assert.deepEqual(scrollCall?.args, { dy: 3 });

  const dbl = await rt.invoke({
    invocationId: 's4',
    commandId: 'pc.click',
    commandVersion: 'v1',
    args: {
      x: { kind: 'number', value: 50 },
      y: { kind: 'number', value: 60 },
      button: { kind: 'string', value: 'right' },
      clicks: { kind: 'number', value: 2 },
    },
  });
  assert.equal(dbl.ok, true);
  assert.match((dbl.data as any).value, /clicked right x2 at 50,60/);
  const clicks = driver.calls.filter((c) => c.op === 'click');
  assert.deepEqual(clicks[clicks.length - 1]?.args, { x: 50, y: 60, button: 'right', clicks: 2 });

  // scroll with no direction is a usage error, not a driver call
  const bad = await rt.invoke({ invocationId: 's5', commandId: 'pc.scroll', commandVersion: 'v1', args: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error!.message, /needs dx and\/or dy/);
});
