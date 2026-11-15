import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AndroidRuntime, FakeAndroidBridge } from '../src/runtimes/android.js';

function call(rt: AndroidRuntime, commandId: string, args: Record<string, unknown> = {}) {
  const casted = Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === 'number' ? { kind: 'number', value: v } : { kind: 'string', value: String(v) }]),
  );
  return rt.invoke({ invocationId: `inv-${commandId}`, commandId, commandVersion: 'v1', args: casted as any });
}

test('android runtime advertises the Hatch-style catalog', async () => {
  const rt = new AndroidRuntime({ bridge: new FakeAndroidBridge() });
  const snap = await rt.snapshot();
  assert.equal(snap.runtimeKind, 'android');
  assert.deepEqual(
    snap.commands.map((c) => c.id),
    ['android.device.info', 'android.screenshot', 'android.tap', 'android.swipe', 'android.input_text', 'android.key', 'android.app.launch'],
  );
  assert.ok(snap.triggers.some((t) => t.id === 'android.geofence.enter'));
});

test('device info parses getprop output', async () => {
  const rt = new AndroidRuntime({ bridge: new FakeAndroidBridge() });
  const res = await call(rt, 'android.device.info');
  assert.equal(res.ok, true);
  const info = JSON.parse((res.data as any).value);
  assert.deepEqual(info, { brand: 'demo', model: 'Pixel 8', android: '15' });
});

test('screenshot returns an image payload for the vision path', async () => {
  const rt = new AndroidRuntime({ bridge: new FakeAndroidBridge() });
  const res = await call(rt, 'android.screenshot');
  assert.equal(res.ok, true);
  assert.equal((res.data as any).kind, 'image');
  assert.equal(Buffer.from((res.data as any).value, 'base64').toString(), 'fake-android-png');
});

test('tap / swipe / text / key / launch map to input commands', async () => {
  const bridge = new FakeAndroidBridge();
  const rt = new AndroidRuntime({ bridge });

  const tap = await call(rt, 'android.tap', { x: 120, y: 640 });
  assert.equal(tap.ok, true);
  assert.ok(bridge.calls.some((c) => c.cmd === 'input tap 120 640'));

  const swipe = await call(rt, 'android.swipe', { x1: 10, y1: 900, x2: 10, y2: 100, durationMs: 250 });
  assert.ok(bridge.calls.some((c) => c.cmd === 'input swipe 10 900 10 100 250'));
  assert.equal(swipe.ok, true);

  const typed = await call(rt, 'android.input_text', { text: 'hi there' });
  assert.ok(bridge.calls.some((c) => c.cmd === "input text 'hi%sthere'"), 'spaces become %s for adb input');
  assert.equal(typed.ok, true);

  const back = await call(rt, 'android.key', { key: 'back' });
  assert.ok(bridge.calls.some((c) => c.cmd === 'input keyevent 4'));
  assert.equal(back.ok, true);

  const bad = await call(rt, 'android.key', { key: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error!.message, /unknown android key/);

  const launch = await call(rt, 'android.app.launch', { package: 'com.example.app' });
  assert.ok(bridge.calls.some((c) => c.cmd === "monkey -p 'com.example.app' 1"));
  assert.equal(launch.ok, true);
});

test('reports 503 when no device/bridge is available', async () => {
  const bridge = new FakeAndroidBridge();
  bridge.available = async () => false;
  const rt = new AndroidRuntime({ bridge });
  const res = await call(rt, 'android.screenshot');
  assert.equal(res.ok, false);
  assert.equal(res.error!.code, 503);
});
