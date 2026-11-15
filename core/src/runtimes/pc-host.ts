/**
 * PC host runtime — the HeyClicky/Dots actuator layer for desktops.
 *
 * Contract mirrors both RE studies: screen capture, window listing,
 * input injection (coordinate or a11y-indexed), app launch, file read.
 * Execution goes through a NativeDriver: PowerShell+.NET on Windows,
 * X11 tools on Linux, a fake driver for tests and dry runs.
 * Commands with `defaultApproval: ASK_ALWAYS` always gate first.
 */

import * as fs from 'node:fs';

import type {
  Args,
  ArgValue,
  CapabilitySnapshot,
  CommandResult,
  CommandSpec,
  InvokeCommand,
  TriggerEvent,
} from '../types.js';
import type { Runtime } from '../registry.js';
import { detectDriver, type A11yElement, type NativeDriver } from './pc-drivers.js';

const SPECS: CommandSpec[] = [
  {
    id: 'pc.screenshot',
    version: 'v1',
    title: 'Take a screenshot of the desktop',
    description: 'Captures the screen and returns a PNG you can see. Use pc.screen_info first so you know the coordinate space.',
    args: [
      { name: 'windowId', type: 'string', description: 'Optional window id; omit for full desktop', required: false },
    ],
    defaultApproval: 'AUTO',
  },
  {
    id: 'pc.screen_info',
    version: 'v1',
    title: 'Get screen size and DPI scale',
    description: 'Returns { width, height, scale }. Coordinates for pc.click are in these units — call this before planning clicks from a screenshot.',
    args: [],
    defaultApproval: 'AUTO',
  },
  {
    id: 'pc.get_active_window',
    version: 'v1',
    title: 'Get the focused window',
    description: 'Returns the title, app and id of the window that currently has keyboard focus.',
    args: [],
    defaultApproval: 'AUTO',
  },
  {
    id: 'pc.list_windows',
    version: 'v1',
    title: 'List open windows',
    description: 'Returns the windows currently open, with ids, titles and owning apps.',
    args: [],
    defaultApproval: 'AUTO',
  },
  {
    id: 'pc.click',
    version: 'v1',
    title: 'Click on the screen',
    description: 'Clicks at a coordinate, or on an a11y element by elementIndex from the latest pc.a11y_tree snapshot (preferred when available — indices survive layout shifts better than pixels).',
    args: [
      { name: 'x', type: 'number', description: 'X coordinate (omit when using elementIndex)', required: false },
      { name: 'y', type: 'number', description: 'Y coordinate (omit when using elementIndex)', required: false },
      { name: 'elementIndex', type: 'number', description: 'Element index from the latest pc.a11y_tree result; clicks its center', required: false },
      { name: 'button', type: 'enum', description: 'Mouse button (default left)', enumValues: ['left', 'middle', 'right'], required: false },
      { name: 'clicks', type: 'number', description: 'Number of clicks, 2 = double-click (default 1)', required: false },
    ],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'pc.a11y_tree',
    version: 'v1',
    title: 'List interactive elements of the target window',
    description: 'Returns indexed accessibility elements (role, name, position) for a window — or the foreground app when windowId is omitted. Cheaper and more robust than screenshots for choosing click targets; pass the index to pc.click as elementIndex.',
    args: [
      { name: 'windowId', type: 'string', description: 'Window id from pc.list_windows; omit for the foreground app', required: false },
    ],
    defaultApproval: 'AUTO',
  },
  {
    id: 'pc.scroll',
    version: 'v1',
    title: 'Scroll the mouse wheel',
    description: 'Scrolls at the current pointer position. dy > 0 scrolls content down, dy < 0 up; dx > 0 right, dx < 0 left. Units are wheel notches (e.g. 3).',
    args: [
      { name: 'dx', type: 'number', description: 'Horizontal notches', required: false },
      { name: 'dy', type: 'number', description: 'Vertical notches', required: false },
    ],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'pc.type_text',
    version: 'v1',
    title: 'Type text into the focused window',
    description: 'Injects keyboard input. NEVER use for passwords/secrets.',
    args: [{ name: 'text', type: 'string', description: 'Text to type', required: true }],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'pc.press_key',
    version: 'v1',
    title: 'Press a key chord',
    description: 'Presses a key or key chord (e.g. "ctrl+s").',
    args: [{ name: 'keys', type: 'string', description: 'Key chord, "+"-separated', required: true }],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'pc.launch_app',
    version: 'v1',
    title: 'Launch an application',
    description: 'Starts an app by id/name so its window can be targeted.',
    args: [{ name: 'appId', type: 'string', description: 'App to launch', required: true }],
    defaultApproval: 'ASK_ONCE',
  },
  {
    id: 'pc.files.read',
    version: 'v1',
    title: 'Read a file on the user machine',
    description: 'Reads a text file (truncated). Sensitive paths should be refused.',
    args: [{ name: 'path', type: 'string', description: 'Absolute file path', required: true }],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'pc.files.watch',
    version: 'v1',
    title: 'Watch a file or folder for changes',
    description: 'Emits a trigger event whenever the target changes — use when the user asks you to react proactively ("tell me when X changes").',
    args: [{ name: 'path', type: 'string', description: 'Absolute path to a file or folder', required: true }],
    defaultApproval: 'ASK_ONCE',
  },
  {
    id: 'pc.hotkey.listen',
    version: 'v1',
    title: 'React to a global hotkey',
    description: 'Emits a trigger event whenever the user presses the given chord (e.g. "ctrl+alt+k").',
    args: [{ name: 'chord', type: 'string', description: 'Key chord, "+"-separated (ctrl/alt/shift/win + key)', required: true }],
    defaultApproval: 'ASK_ONCE',
  },
];

export interface PcHostOptions {
  runtimeId?: string;
  /** Explicit driver; when omitted, detectDriver() probes the machine. */
  driver?: NativeDriver;
}

export class PcHostRuntime implements Runtime {
  readonly runtimeId: string;
  private driver?: NativeDriver;
  /** Latest a11y snapshot; elementIndex clicks resolve against it. */
  private lastA11y: A11yElement[] | null = null;
  private triggerHandler?: (event: TriggerEvent) => void;
  private watchers: fs.FSWatcher[] = [];
  private watchedPaths = new Set<string>();
  private lastWatchFireMs = 0;

  constructor(opts: PcHostOptions = {}) {
    this.runtimeId = opts.runtimeId ?? 'pc-host';
    this.driver = opts.driver;
  }

  async snapshot(): Promise<CapabilitySnapshot> {
    if (!this.driver) this.driver = await detectDriver();
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'pc-host',
      protocolVersion: '1',
      commands: SPECS,
      dataSources: [
        { id: 'pc.files.watch', version: 'v1', description: 'File system change events', supportsBackfill: true },
        { id: 'pc.clipboard', version: 'v1', description: 'Clipboard read/write events', supportsBackfill: false },
      ],
      triggers: [
        { id: 'pc.hotkey', version: 'v1', description: 'Global hotkey pressed' },
        { id: 'pc.files.watch', version: 'v1', description: 'Watched file or folder changed' },
      ],
    };
  }

  async invoke(cmd: InvokeCommand): Promise<CommandResult> {
    if (!(await this.ensureDriver())) {
      return {
        invocationId: cmd.invocationId,
        ok: false,
        error: {
          code: 503,
          message: 'no native driver available on this machine (need Windows or an X11 Linux desktop)',
          retryable: false,
        },
      };
    }
    try {
      const data = await this.execute(cmd.commandId, cmd.args);
      return { invocationId: cmd.invocationId, ok: true, data };
    } catch (err) {
      return {
        invocationId: cmd.invocationId,
        ok: false,
        error: { code: 500, message: (err as Error).message, retryable: false },
      };
    }
  }

  onTrigger(handler: (event: TriggerEvent) => void): void {
    this.triggerHandler = handler;
  }

  /** Emit a proactive event — the Muse wake-the-agent path. */
  private emitTrigger(triggerId: string, payload: unknown): void {
    this.triggerHandler?.({
      triggerId,
      payload,
      occurredAtMs: Date.now(),
      backfill: { cursor: String(Date.now()), hasMore: false },
    });
  }

  private async ensureDriver(): Promise<NativeDriver | undefined> {
    if (!this.driver) this.driver = await detectDriver();
    return this.driver;
  }
  private watchFiles(target: string): void {
    if (this.watchedPaths.has(target)) return;
    this.watchedPaths.add(target);
    const recursive = process.platform === 'win32' || process.platform === 'darwin';
    const watcher = fs.watch(target, { recursive }, (eventType, filename) => {
      const now = Date.now();
      if (now - this.lastWatchFireMs < 300) return; // debounce noisy editors
      this.lastWatchFireMs = now;
      this.emitTrigger('pc.files.watch', { path: target, eventType, filename });
    });
    watcher.unref?.();
    this.watchers.push(watcher);
  }

  async dispose(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.watchedPaths.clear();
  }

  private async execute(commandId: string, args: Args): Promise<ArgValue> {
    const d = this.driver!;
    switch (commandId) {
      case 'pc.screenshot': {
        // Real pixels: the executor attaches image results to the
        // conversation as vision content parts so the model can see.
        const png = await d.screenshot(str(args.windowId));
        return { kind: 'image', value: png };
      }
      case 'pc.list_windows': {
        const windows = await d.listWindows();
        return { kind: 'string', value: windows.map((w) => `${w.windowId}  ${w.title}  [${w.app}]`).join('\n') };
      }
      case 'pc.click': {
        const target: { x?: number; y?: number; button?: 'left' | 'middle' | 'right'; clicks?: number } = {
          x: num(args.x),
          y: num(args.y),
        };
        const button = str(args.button);
        if (button) target.button = button as 'left' | 'middle' | 'right';
        const clicks = num(args.clicks);
        if (clicks !== undefined) target.clicks = Math.max(1, Math.trunc(clicks));

        let label = `at ${num(args.x)},${num(args.y)}`;
        const elementIndex = num(args.elementIndex);
        if (elementIndex !== undefined) {
          if (!this.lastA11y) {
            throw new Error('no a11y snapshot yet — call pc.a11y_tree first, then retry with elementIndex');
          }
          const el = this.lastA11y.find((e) => e.index === Math.trunc(elementIndex));
          if (!el) {
            throw new Error(
              `elementIndex ${Math.trunc(elementIndex)} out of range (0..${this.lastA11y.length - 1}) — call pc.a11y_tree again; the layout may have changed`,
            );
          }
          target.x = Math.round(el.x + el.w / 2);
          target.y = Math.round(el.y + el.h / 2);
          label = `[${el.index}] ${el.role} "${el.name}" at ${target.x},${target.y}`;
        } else if (target.x === undefined || target.y === undefined) {
          throw new Error('pc.click needs x+y coordinates or an elementIndex from pc.a11y_tree');
        }

        await d.click(target);
        return { kind: 'string', value: `clicked ${target.button ?? 'left'} x${target.clicks ?? 1} ${label}` };
      }
      case 'pc.a11y_tree': {
        const els = await d.a11yTree(str(args.windowId));
        this.lastA11y = els;
        if (els.length === 0) {
          return { kind: 'string', value: 'no interactive elements found — the target window may not expose UIA; fall back to pc.screenshot + coordinates' };
        }
        const lines = els.map((e) => `[${e.index}] ${e.role} "${e.name}" (${e.x},${e.y} ${e.w}x${e.h})`);
        return { kind: 'string', value: `${els.length} elements:\n${lines.join('\n')}` };
      }
      case 'pc.scroll': {
        const dx = num(args.dx);
        const dy = num(args.dy);
        if (dx === undefined && dy === undefined) throw new Error('pc.scroll needs dx and/or dy');
        await d.scroll({ ...(dx !== undefined ? { dx } : {}), ...(dy !== undefined ? { dy } : {}) });
        return { kind: 'string', value: `scrolled dx=${dx ?? 0} dy=${dy ?? 0}` };
      }
      case 'pc.screen_info': {
        const info = await d.screenInfo();
        return { kind: 'string', value: JSON.stringify(info) };
      }
      case 'pc.get_active_window': {
        const w = await d.activeWindow();
        return { kind: 'string', value: w ? `${w.title} [${w.app}] (id ${w.windowId})` : 'no active window detected' };
      }
      case 'pc.type_text': {
        const text = str(args.text) ?? '';
        await d.typeText('', text);
        return { kind: 'string', value: `typed ${text.length} chars` };
      }
      case 'pc.press_key': {
        const keys = str(args.keys) ?? '';
        await d.pressKey('', keys);
        return { kind: 'string', value: `pressed ${keys}` };
      }
      case 'pc.launch_app': {
        const appId = str(args.appId) ?? '';
        await d.launchApp(appId);
        return { kind: 'string', value: `launched ${appId}` };
      }
      case 'pc.files.read': {
        const path = str(args.path) ?? '';
        const content = await d.readFile(path, 8_000);
        return { kind: 'string', value: content };
      }
      case 'pc.files.watch': {
        const path = str(args.path) ?? '';
        this.watchFiles(path);
        return { kind: 'string', value: `watching ${path}; a change will wake me` };
      }
      case 'pc.hotkey.listen': {
        const chord = str(args.chord) ?? '';
        if (!d.watchHotkey) throw new Error('this driver cannot listen for global hotkeys');
        await d.watchHotkey(chord, () => this.emitTrigger('pc.hotkey', { chord }));
        return { kind: 'string', value: `listening for ${chord}; pressing it will wake me` };
      }
      default:
        throw new Error(`unknown pc command: ${commandId}`);
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
