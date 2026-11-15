/**
 * Android runtime — the Muse/Hatch pattern: the phone is a device runtime
 * speaking the same typed protocol with versioned commands.
 *
 * Bridge implementations:
 *  - AdbBridge: developer path over `adb` (screen capture, tap, swipe, text,
 *    keys, app launch) — works today with USB debugging enabled.
 *  - FakeAndroidBridge: tests and dry runs.
 * The companion-app bridge (phone app speaking the protocol over WS, with
 * proper Android permissions for SMS/notifications/etc.) is its own
 * milestone; the command surface below is already versioned and stable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

import type { Args, ArgValue, CapabilitySnapshot, CommandResult, CommandSpec, InvokeCommand } from '../types.js';
import type { Runtime } from '../registry.js';

const SPECS: CommandSpec[] = [
  {
    id: 'android.device.info',
    version: 'v1',
    title: 'Get device info',
    description: 'Returns brand, model and Android version of the connected device.',
    args: [],
    defaultApproval: 'AUTO',
  },
  {
    id: 'android.screenshot',
    version: 'v1',
    title: 'Screenshot the phone screen',
    description: 'Captures the device screen; the image is attached for you to see.',
    args: [],
    defaultApproval: 'AUTO',
  },
  {
    id: 'android.tap',
    version: 'v1',
    title: 'Tap on the phone screen',
    description: 'Taps a coordinate on the device screen.',
    args: [
      { name: 'x', type: 'number', description: 'X coordinate', required: true },
      { name: 'y', type: 'number', description: 'Y coordinate', required: true },
    ],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'android.swipe',
    version: 'v1',
    title: 'Swipe on the phone screen',
    description: 'Swipes from one coordinate to another.',
    args: [
      { name: 'x1', type: 'number', description: 'Start X', required: true },
      { name: 'y1', type: 'number', description: 'Start Y', required: true },
      { name: 'x2', type: 'number', description: 'End X', required: true },
      { name: 'y2', type: 'number', description: 'End Y', required: true },
      { name: 'durationMs', type: 'number', description: 'Swipe duration (default 300)', required: false },
    ],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'android.input_text',
    version: 'v1',
    title: 'Type text on the phone',
    description: 'Types text into the focused field on the device.',
    args: [{ name: 'text', type: 'string', description: 'Text to type', required: true }],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'android.key',
    version: 'v1',
    title: 'Press a device key',
    description: 'Sends a hardware/navigation key event (home, back, recents, ...).',
    args: [
      { name: 'key', type: 'enum', description: 'Key to press', enumValues: ['home', 'back', 'recents', 'enter', 'del', 'power', 'volume_up', 'volume_down'], required: true },
    ],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'android.app.launch',
    version: 'v1',
    title: 'Launch an app on the phone',
    description: 'Starts an app by package name (e.g. com.example.app).',
    args: [{ name: 'package', type: 'string', description: 'Package name', required: true }],
    defaultApproval: 'ASK_ONCE',
  },
];

export interface AndroidBridge {
  available(): Promise<boolean>;
  /** `adb shell` for the ADB bridge; app-protocol commands for the app bridge. */
  shell(command: string): Promise<string>;
  screencapPng(): Promise<string>; // base64 PNG
}

/* ---------------- ADB bridge (developer device) ---------------- */

export class AdbBridge implements AndroidBridge {
  constructor(private serial?: string) {}

  private args(rest: string[]): string[] {
    return this.serial ? ['-s', this.serial, ...rest] : rest;
  }

  async available(): Promise<boolean> {
    try {
      const { stdout } = await exec('adb', this.args(['get-state']), { timeout: 5000 });
      return stdout.trim() === 'device';
    } catch {
      return false;
    }
  }

  async shell(command: string): Promise<string> {
    const { stdout } = await exec('adb', this.args(['shell', command]), { timeout: 15_000 });
    return stdout;
  }

  async screencapPng(): Promise<string> {
    const { stdout } = await exec('adb', this.args(['exec-out', 'screencap', '-p']), {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    });
    return Buffer.from(stdout).toString('base64');
  }
}

/* ---------------- Fake bridge (tests, dry runs) ---------------- */

export class FakeAndroidBridge implements AndroidBridge {
  public calls: { cmd: string }[] = [];
  async available(): Promise<boolean> {
    return true;
  }
  async shell(command: string): Promise<string> {
    this.calls.push({ cmd: command });
    if (command.includes('getprop')) {
      return [
        'ro.product.brand: [demo]',
        'ro.product.model: [Pixel 8]',
        'ro.build.version.release: [15]',
      ].join('\n');
    }
    return 'ok';
  }
  async screencapPng(): Promise<string> {
    this.calls.push({ cmd: 'screencap' });
    return Buffer.from('fake-android-png').toString('base64');
  }
}

/* ---------------- runtime ---------------- */

const KEYCODES: Record<string, number> = {
  home: 3, back: 4, recents: 187, enter: 66, del: 67,
  power: 26, volume_up: 24, volume_down: 25,
};

export interface AndroidRuntimeOptions {
  runtimeId?: string;
  bridge?: AndroidBridge; // default: AdbBridge (auto-checked on first use)
}

export class AndroidRuntime implements Runtime {
  readonly runtimeId: string;
  private bridge: AndroidBridge;

  constructor(opts: AndroidRuntimeOptions = {}) {
    this.runtimeId = opts.runtimeId ?? 'android';
    this.bridge = opts.bridge ?? new AdbBridge();
  }

  async snapshot(): Promise<CapabilitySnapshot> {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'android',
      protocolVersion: '1',
      commands: SPECS,
      dataSources: [
        { id: 'android.notifications', version: 'v1', description: 'Notification events (app bridge, next milestone)', supportsBackfill: true },
      ],
      triggers: [{ id: 'android.geofence.enter', version: 'v1', description: 'Entered a geofence (app bridge, next milestone)' }],
    };
  }

  async invoke(cmd: InvokeCommand): Promise<CommandResult> {
    if (!(await this.bridge.available())) {
      return {
        invocationId: cmd.invocationId,
        ok: false,
        error: { code: 503, message: 'no Android device connected (need `adb` with USB debugging, or the companion app)', retryable: true },
      };
    }
    try {
      const data = await this.execute(cmd.commandId, cmd.args);
      return { invocationId: cmd.invocationId, ok: true, data };
    } catch (err) {
      return { invocationId: cmd.invocationId, ok: false, error: { code: 500, message: (err as Error).message, retryable: false } };
    }
  }

  private async execute(commandId: string, args: Args): Promise<ArgValue> {
    switch (commandId) {
      case 'android.device.info': {
        const out = await this.bridge.shell('getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release');
        const grab = (key: string) => new RegExp(`${key}: \\[([^\\]]*)\\]`).exec(out)?.[1] ?? 'unknown';
        return { kind: 'string', value: JSON.stringify({ brand: grab('ro.product.brand'), model: grab('ro.product.model'), android: grab('ro.build.version.release') }) };
      }
      case 'android.screenshot': {
        const png = await this.bridge.screencapPng();
        return { kind: 'image', value: png };
      }
      case 'android.tap': {
        await this.bridge.shell(`input tap ${Math.trunc(num(args.x) ?? 0)} ${Math.trunc(num(args.y) ?? 0)}`);
        return { kind: 'string', value: `tapped ${num(args.x)},${num(args.y)}` };
      }
      case 'android.swipe': {
        const duration = Math.trunc(num(args.durationMs) ?? 300);
        await this.bridge.shell(
          `input swipe ${Math.trunc(num(args.x1) ?? 0)} ${Math.trunc(num(args.y1) ?? 0)} ${Math.trunc(num(args.x2) ?? 0)} ${Math.trunc(num(args.y2) ?? 0)} ${duration}`,
        );
        return { kind: 'string', value: `swiped (${num(args.x1)},${num(args.y1)}) → (${num(args.x2)},${num(args.y2)})` };
      }
      case 'android.input_text': {
        const text = str(args.text) ?? '';
        // adb input text needs %s for spaces and shell-escaping for specials
        const escaped = text.replace(/ /g, '%s').replace(/'/g, "\\'");
        await this.bridge.shell(`input text '${escaped}'`);
        return { kind: 'string', value: `typed ${text.length} chars on device` };
      }
      case 'android.key': {
        const key = str(args.key) ?? '';
        const code = KEYCODES[key];
        if (code === undefined) throw new Error(`unknown android key: ${key} (allowed: ${Object.keys(KEYCODES).join(', ')})`);
        await this.bridge.shell(`input keyevent ${code}`);
        return { kind: 'string', value: `pressed ${key}` };
      }
      case 'android.app.launch': {
        const pkg = str(args.package) ?? '';
        await this.bridge.shell(`monkey -p '${pkg.replace(/'/g, "\\'")}' 1`);
        return { kind: 'string', value: `launched ${pkg}` };
      }
      default:
        throw new Error(`unknown android command: ${commandId}`);
    }
  }

  static specs(): CommandSpec[] {
    return SPECS;
  }
}

function str(v: Args[string] | undefined): string | undefined {
  return v?.kind === 'string' ? v.value : undefined;
}

function num(v: Args[string] | undefined): number | undefined {
  return v?.kind === 'number' ? v.value : undefined;
}
