/**
 * PC host native drivers — platform implementations behind the runtime contract.
 *
 * Windows (first-class, per HeyClicky lessons): PowerShell + .NET, no
 * compiled dependencies. Linux: standard tools (xdotool/wmctrl/scrot),
 * graceful errors when absent. A FakeDriver powers tests and dry runs.
 *
 * Coordinate space: pixels as reported by screenInfo() — on Windows this is
 * the virtual screen in logical pixels; on scaled displays both screenshots
 * and SetCursorPos/xdotool use the same logical space, so coordinates the
 * model reads off a screenshot map directly to clicks.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface WindowInfo {
  windowId: string;
  title: string;
  app: string;
}

export interface ScreenInfo {
  width: number;
  height: number;
  /** DPI scale factor (1 = 100%). Helps the model sanity-check coordinates. */
  scale?: number;
}

export type MouseButton = 'left' | 'middle' | 'right';

export interface ClickTarget {
  windowId?: string;
  x?: number;
  y?: number;
  button?: MouseButton;
  /** Number of consecutive clicks (2 = double-click). Default 1. */
  clicks?: number;
}

export interface ScrollDelta {
  /** Horizontal notches; positive = content scrolls right. */
  dx?: number;
  /** Vertical notches; positive = content scrolls down (browser convention). */
  dy?: number;
}

/**
 * One indexed interactive element from the accessibility tree — the Dots
 * pattern: the model references elements by index (token-cheap, robust to
 * pixel drift) and clicks resolve to the element's center coordinate.
 */
export interface A11yElement {
  index: number;
  role: string; // "Button", "Edit", "MenuItem", ...
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NativeDriver {
  readonly platform: 'windows' | 'linux' | 'macos' | 'fake';
  /** Cheap probe: does this driver actually work on the current machine? */
  available(): Promise<boolean>;
  listWindows(): Promise<WindowInfo[]>;
  activeWindow(): Promise<WindowInfo | undefined>;
  screenInfo(): Promise<ScreenInfo>;
  screenshot(windowId?: string): Promise<string>; // PNG base64
  /** Indexed a11y elements for a window (or the foreground app when omitted). */
  a11yTree(windowId?: string): Promise<A11yElement[]>;
  click(target: ClickTarget): Promise<void>;
  scroll(delta: ScrollDelta): Promise<void>;
  typeText(windowId: string, text: string): Promise<void>;
  pressKey(windowId: string, keys: string): Promise<void>;
  launchApp(appId: string): Promise<void>;
  readFile(path: string, maxBytes: number): Promise<string>;
  /**
   * Listen for a global hotkey chord; calls cb on each press.
   * Returns a stop function. Optional — drivers that can't listen throw.
   */
  watchHotkey?(chord: string, cb: () => void): Promise<() => void>;
}

/* ------------------------------------------------------------------ */
/* Windows — PowerShell driver                                         */
/* ------------------------------------------------------------------ */

const PS = {
  screenshot: `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
$g.Dispose(); $bmp.Dispose()`,

  listWindows: `
Add-Type -AssemblyName System.Windows.Forms
Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
  "{0}|{1}|{2}" -f $_.Id, ($_.MainWindowTitle -replace '\\|', '/'), $_.ProcessName
}`,

  screenInfo: `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$v = [System.Windows.Forms.SystemInformation]::VirtualScreen
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$dpi = [Math]::Round($g.DpiX / 96, 2)
$g.Dispose()
"{0}|{1}|{2}" -f $v.Width, $v.Height, $dpi`,

  activeWindow: `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Foreground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [Foreground]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
$null = [Foreground]::GetWindowText($h, $sb, 512)
$procId = [uint32]0
$null = [Foreground]::GetWindowThreadProcessId($h, [ref]$procId)
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
$app = if ($p) { $p.ProcessName } else { '' }
"{0}|{1}|{2}" -f $procId, ($sb.ToString() -replace '\\|', '/'), $app`,

  click: `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Clicker {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
}
"@
[Clicker]::SetCursorPos(__X__, __Y__)
for ($i = 0; $i -lt __CLICKS__; $i++) {
  [Clicker]::mouse_event(__DOWN__, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [Clicker]::mouse_event(__UP__, 0, 0, 0, [UIntPtr]::Zero)
  if (__CLICKS__ -gt 1) { Start-Sleep -Milliseconds 90 }
}`,

  scroll: `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Wheeler {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
}
"@
[Wheeler]::mouse_event(__FLAG__, 0, 0, __DELTA__, [UIntPtr]::Zero)`,

  typeText: (win: string, text: string) => withActivate(win, `
[System.Windows.Forms.SendKeys]::SendWait(${psString(sendKeysEscape(text))})`),

  pressKey: (win: string, keys: string) => withActivate(win, `
[System.Windows.Forms.SendKeys]::SendWait(${psString(keys)})`),

  launchApp: 'Start-Process __APP__',
};

/** AppActivate preamble, only when a window id was actually given. */
function withActivate(windowId: string, body: string): string {
  const activate = windowId
    ? `
$wshell = New-Object -ComObject wscript.shell
$null = $wshell.AppActivate(${psWindowId(windowId)})
Start-Sleep -Milliseconds 150`
    : '';
  return `
Add-Type -AssemblyName System.Windows.Forms${activate}${body}`;
}

/**
 * UIAutomation dump: walks the target app's control tree and prints one
 * indexed, interactive, on-screen element per line as
 * "index|role|name|x|y|w|h". All managed .NET (UIA ships with Windows) —
 * no compiled helpers. Falls back to the foreground window when no PID.
 */
const UIA_DUMP = `
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public class UiaDump {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  public static string Dump(int pid) {
    AutomationElement target = null;
    if (pid > 0) {
      target = AutomationElement.RootElement.FindFirst(TreeScope.Children,
        new PropertyCondition(AutomationElement.ProcessIdProperty, pid));
    }
    if (target == null) {
      IntPtr h = GetForegroundWindow();
      uint fpid;
      GetWindowThreadProcessId(h, out fpid);
      target = AutomationElement.RootElement.FindFirst(TreeScope.Children,
        new PropertyCondition(AutomationElement.ProcessIdProperty, (int)fpid));
    }
    if (target == null) return "";
    var sb = new StringBuilder();
    int count = 0;
    Walk(target, 0, sb, ref count);
    return sb.ToString();
  }

  static bool Interesting(string role, string name) {
    switch (role) {
      case "Button": case "Edit": case "CheckBox": case "RadioButton":
      case "ComboBox": case "ListItem": case "MenuItem": case "TabItem":
      case "Hyperlink": case "TreeItem": case "Slider": case "Spinner":
      case "Text": case "Image": case "Document":
        return true;
      default:
        return name.Length > 0;
    }
  }

  static void Walk(AutomationElement el, int depth, StringBuilder sb, ref int count) {
    if (depth > 12 || count >= 350) return;
    string role = "";
    string name = "";
    System.Windows.Rect rect = System.Windows.Rect.Empty;
    bool offscreen = true;
    try {
      role = el.Current.ControlType.ProgrammaticName ?? "";
      if (role.StartsWith("ControlType.")) role = role.Substring(12);
      name = (el.Current.Name ?? "").Replace("|", "/").Replace("\r", " ").Replace("\n", " ");
      rect = el.Current.BoundingRectangle;
      offscreen = el.Current.IsOffscreen;
    } catch { }
    if (!offscreen && rect.Width >= 2 && rect.Height >= 2 && Interesting(role, name)) {
      sb.Append(count).Append('|').Append(role).Append('|').Append(name).Append('|')
        .Append((int)rect.X).Append('|').Append((int)rect.Y).Append('|')
        .Append((int)rect.Width).Append('|').Append((int)rect.Height).Append('\n');
      count++;
    }
    var walker = TreeWalker.ControlViewWalker;
    AutomationElement child = null;
    try { child = walker.GetFirstChild(el); } catch { }
    while (child != null && count < 350) {
      Walk(child, depth + 1, sb, ref count);
      try { child = walker.GetNextSibling(child); } catch { break; }
    }
  }
}
"@
Add-Type -TypeDefinition $src -ReferencedAssemblies 'UIAutomationClient', 'UIAutomationTypes'
[UiaDump]::Dump(__PID__)`;

/** Parse one UIA dump line: index|role|name|x|y|w|h */
function parseA11yLine(line: string): A11yElement | undefined {
  const parts = line.split('|');
  if (parts.length < 7) return undefined;
  const [index, role, name, x, y, w, h] = parts;
  const el: A11yElement = {
    index: Number(index),
    role: role ?? '',
    name: name ?? '',
    x: Number(x),
    y: Number(y),
    w: Number(w),
    h: Number(h),
  };
  return Number.isNaN(el.x) || Number.isNaN(el.y) ? undefined : el;
}

/** Win32 mouse_event flags per button: [down, up]. */
const WIN_BUTTON_FLAGS: Record<MouseButton, [number, number]> = {
  left: [0x0002, 0x0004],
  middle: [0x0020, 0x0040],
  right: [0x0008, 0x0010],
};

export class WindowsPowerShellDriver implements NativeDriver {
  readonly platform = 'windows' as const;

  async available(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
      await exec('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async listWindows(): Promise<WindowInfo[]> {
    const { stdout } = await this.pwsh(PS.listWindows);
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, title, app] = l.split('|');
        return { windowId: id, title: title ?? '', app: app ?? '' };
      });
  }

  async activeWindow(): Promise<WindowInfo | undefined> {
    const { stdout } = await this.pwsh(PS.activeWindow);
    const line = stdout.trim();
    if (!line) return undefined;
    const [id, title, app] = line.split('|');
    if (!title) return undefined;
    return { windowId: id ?? '', title, app: app ?? '' };
  }

  async screenInfo(): Promise<ScreenInfo> {
    const { stdout } = await this.pwsh(PS.screenInfo);
    const [w, h, dpi] = stdout.trim().split('|');
    return { width: Number(w), height: Number(h), scale: Number(dpi) || 1 };
  }

  async screenshot(): Promise<string> {
    const { stdout } = await this.pwsh(PS.screenshot);
    return stdout.trim();
  }

  async a11yTree(windowId?: string): Promise<A11yElement[]> {
    const pid = windowId && /^\d+$/.test(windowId) ? windowId : '0';
    const { stdout } = await this.pwsh(UIA_DUMP.replace('__PID__', pid));
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(parseA11yLine)
      .filter((el): el is A11yElement => el !== undefined);
  }

  async click(target: ClickTarget): Promise<void> {
    if (target.x === undefined || target.y === undefined) {
      throw new Error('coordinate clicks only on Windows driver for now');
    }
    const [down, up] = WIN_BUTTON_FLAGS[target.button ?? 'left'];
    const clicks = Math.max(1, Math.trunc(target.clicks ?? 1));
    const script = PS.click
      .replace('__X__', String(Math.trunc(target.x)))
      .replace('__Y__', String(Math.trunc(target.y)))
      .replaceAll('__DOWN__', String(down))
      .replaceAll('__UP__', String(up))
      .replaceAll('__CLICKS__', String(clicks));
    await this.pwsh(script);
  }

  async scroll(delta: ScrollDelta): Promise<void> {
    // Win32 wheel deltas: +120 = up, -120 = down (vertical); horizontal wheel
    // is a separate flag, positive = right. dy>0 means "content down" here,
    // i.e. wheel moves down, so the sign flips.
    const dy = Math.trunc(delta.dy ?? 0);
    const dx = Math.trunc(delta.dx ?? 0);
    if (dy !== 0) {
      await this.pwsh(
        PS.scroll.replace('__FLAG__', '2048').replace('__DELTA__', String(-120 * dy)),
      );
    }
    if (dx !== 0) {
      await this.pwsh(
        PS.scroll.replace('__FLAG__', '4096').replace('__DELTA__', String(120 * dx)),
      );
    }
  }

  async typeText(windowId: string, text: string): Promise<void> {
    await this.pwsh(PS.typeText(windowId, text));
  }

  async pressKey(windowId: string, keys: string): Promise<void> {
    // "ctrl+s" -> "^s" in SendKeys notation.
    const mapped = keys
      .split('+')
      .map((k) => k.trim().toLowerCase())
      .map((k) => SENDKEYS_KEYS[k] ?? k)
      .join('');
    await this.pwsh(PS.pressKey(windowId, mapped));
  }

  async launchApp(appId: string): Promise<void> {
    await this.pwsh(PS.launchApp.replace('__APP__', psString(appId)));
  }

  async readFile(path: string, maxBytes: number): Promise<string> {
    const max = Math.trunc(maxBytes);
    const { stdout } = await this.pwsh(
      `$bytes = [System.IO.File]::ReadAllBytes(${psString(path)}); ` +
        `if ($bytes.Length -gt ${max}) { $bytes = $bytes[0..(${max} - 1)] }; ` +
        `[System.Text.Encoding]::UTF8.GetString($bytes)`,
    );
    return stdout;
  }

  /**
   * Global hotkey listener: a long-lived PowerShell process polls
   * GetAsyncKeyState and prints "HOTKEY" whenever the chord is fully held.
   * Re-arming happens on release, so one keypress = one event.
   */
  async watchHotkey(chord: string, cb: () => void): Promise<() => void> {
    const vks = chordToVkCodes(chord);
    if (vks.length === 0 || vks.some((v) => Number.isNaN(v))) {
      throw new Error(`unsupported hotkey chord: ${chord}`);
    }
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyProbe { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v); }
"@
$vks = @(${vks.join(', ')})
while ($true) {
  $all = $true
  foreach ($vk in $vks) { if (-not ([KeyProbe]::GetAsyncKeyState($vk) -band 0x8000)) { $all = $false; break } }
  if ($all) {
    Write-Output 'HOTKEY'
    while ($all) {
      Start-Sleep -Milliseconds 80
      foreach ($vk in $vks) { if (-not ([KeyProbe]::GetAsyncKeyState($vk) -band 0x8000)) { $all = $false; break } }
    }
  }
  Start-Sleep -Milliseconds 120
}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    child.stdout?.on('data', (buf: Buffer) => {
      if (buf.toString().includes('HOTKEY')) cb();
    });
    child.on('error', () => undefined);
    return () => {
      child.kill();
    };
  }

  private async pwsh(script: string): Promise<{ stdout: string }> {
    return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
}

const SENDKEYS_KEYS: Record<string, string> = {
  ctrl: '^',
  shift: '+',
  alt: '%',
  // SendKeys cannot emit the Win key; ^{ESC} is the practical stand-in
  // (opens the Start menu).
  win: '^{ESC}',
  enter: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  del: '{DEL}',
  backspace: '{BS}',
  home: '{HOME}',
  end: '{END}',
  pgup: '{PGUP}',
  pgdn: '{PGDN}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}',
  f5: '{F5}', f6: '{F6}', f7: '{F7}', f8: '{F8}',
  f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
};

/** Escape a JS string into a PS single-quoted literal. */
function psString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Window ids arrive as strings; AppActivate wants an int PID when numeric. */
function psWindowId(windowId: string): string {
  return /^\d+$/.test(windowId) ? windowId : psString(windowId);
}

/** SendKeys treats +^%~(){} specially. */
function sendKeysEscape(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

/** Win32 virtual-key codes for hotkey chords ("ctrl+alt+k" -> [0x11, 0x12, 0x4B]). */
const VK_CODES: Record<string, number> = {
  ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b,
  enter: 0x0d, tab: 0x09, esc: 0x1b, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  del: 0x2e, backspace: 0x08, home: 0x24, end: 0x23,
  pgup: 0x21, pgdn: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};

function chordToVkCodes(chord: string): number[] {
  return chord
    .split('+')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => {
      if (VK_CODES[k] !== undefined) return VK_CODES[k];
      if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
      return NaN;
    });
}

/* ------------------------------------------------------------------ */
/* Linux — standard X11 tools                                          */
/* ------------------------------------------------------------------ */

export class LinuxX11Driver implements NativeDriver {
  readonly platform = 'linux' as const;

  async available(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
      await exec('which', ['xdotool']);
      return true;
    } catch {
      return false;
    }
  }

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const { stdout } = await exec('wmctrl', ['-l'], { timeout: 5000 });
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const parts = l.split(/\s+/);
          return { windowId: parts[0], app: parts[parts.length - 1] ?? '', title: parts.slice(3, -1).join(' ') };
        });
    } catch {
      throw new Error('wmctrl not available; install wmctrl');
    }
  }

  async activeWindow(): Promise<WindowInfo | undefined> {
    try {
      const { stdout: id } = await exec('xdotool', ['getactivewindow'], { timeout: 5000 });
      const { stdout: name } = await exec('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 5000 });
      const windowId = id.trim();
      if (!windowId) return undefined;
      return { windowId, title: name.trim(), app: '' };
    } catch {
      return undefined;
    }
  }

  async screenInfo(): Promise<ScreenInfo> {
    try {
      const { stdout } = await exec('xdpyinfo', [], { timeout: 5000 });
      const m = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(stdout);
      if (m) return { width: Number(m[1]), height: Number(m[2]) };
    } catch {
      /* fall through to xdotool */
    }
    const { stdout } = await exec('xdotool', ['getdisplaygeometry'], { timeout: 5000 });
    const [w, h] = stdout.trim().split(/\s+/);
    return { width: Number(w), height: Number(h) };
  }

  async screenshot(): Promise<string> {
    const { stdout } = await exec('import', ['-window', 'root', 'png:-'], {
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'binary',
    });
    return Buffer.from(stdout, 'binary').toString('base64');
  }

  async a11yTree(): Promise<A11yElement[]> {
    throw new Error(
      'indexed a11y on Linux needs AT-SPI bindings (not implemented yet) — use pc.screenshot + coordinate clicks on this platform',
    );
  }

  async click(target: ClickTarget): Promise<void> {
    const button = target.button === 'right' ? '3' : target.button === 'middle' ? '2' : '1';
    const clicks = Math.max(1, Math.trunc(target.clicks ?? 1));
    const args: string[] = [];
    if (target.x !== undefined && target.y !== undefined) {
      args.push('mousemove', String(target.x), String(target.y));
    }
    args.push('click', '--repeat', String(clicks), button);
    await exec('xdotool', args);
  }

  async scroll(delta: ScrollDelta): Promise<void> {
    // X11 wheel buttons: 4 up, 5 down, 6 left, 7 right.
    const dy = Math.trunc(delta.dy ?? 0);
    const dx = Math.trunc(delta.dx ?? 0);
    if (dy !== 0) {
      await exec('xdotool', ['click', '--repeat', String(Math.abs(dy)), dy > 0 ? '5' : '4']);
    }
    if (dx !== 0) {
      await exec('xdotool', ['click', '--repeat', String(Math.abs(dx)), dx > 0 ? '7' : '6']);
    }
  }

  async typeText(_windowId: string, text: string): Promise<void> {
    await exec('xdotool', ['type', '--delay', '20', text]);
  }

  async pressKey(_windowId: string, keys: string): Promise<void> {
    await exec('xdotool', ['key', keys.replace(/\+/g, '+')]);
  }

  async launchApp(appId: string): Promise<void> {
    await exec(appId, [], { timeout: 5000 }).catch(() => {
      throw new Error(`cannot launch ${appId}`);
    });
  }

  async readFile(path: string, maxBytes: number): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path);
    return buf.subarray(0, maxBytes).toString('utf8');
  }

  async watchHotkey(): Promise<() => void> {
    throw new Error(
      'global hotkeys on Linux need xbindkeys/keyd bindings (not implemented) — pc.files.watch and scheduled triggers work everywhere',
    );
  }
}

/* ------------------------------------------------------------------ */
/* Fake driver — tests, dry runs, demos                                 */
/* ------------------------------------------------------------------ */

export class FakeDriver implements NativeDriver {
  readonly platform = 'fake' as const;
  public calls: { op: string; args: unknown }[] = [];

  async available(): Promise<boolean> {
    return true;
  }
  async listWindows(): Promise<WindowInfo[]> {
    this.calls.push({ op: 'listWindows', args: {} });
    return [{ windowId: 'w1', title: 'Demo Window', app: 'demo' }];
  }
  async activeWindow(): Promise<WindowInfo | undefined> {
    this.calls.push({ op: 'activeWindow', args: {} });
    return { windowId: 'w1', title: 'Demo Window', app: 'demo' };
  }
  async screenInfo(): Promise<ScreenInfo> {
    this.calls.push({ op: 'screenInfo', args: {} });
    return { width: 1920, height: 1080, scale: 1 };
  }
  async screenshot(): Promise<string> {
    this.calls.push({ op: 'screenshot', args: {} });
    return Buffer.from('fake-png').toString('base64');
  }
  async a11yTree(): Promise<A11yElement[]> {
    this.calls.push({ op: 'a11yTree', args: {} });
    return [
      { index: 0, role: 'button', name: 'Save', x: 100, y: 200, w: 80, h: 24 },
      { index: 1, role: 'edit', name: 'Search', x: 100, y: 150, w: 200, h: 24 },
    ];
  }
  async click(target: ClickTarget): Promise<void> {
    this.calls.push({ op: 'click', args: target });
  }
  async scroll(delta: ScrollDelta): Promise<void> {
    this.calls.push({ op: 'scroll', args: delta });
  }
  async typeText(windowId: string, text: string): Promise<void> {
    this.calls.push({ op: 'typeText', args: { windowId, text } });
  }
  async pressKey(windowId: string, keys: string): Promise<void> {
    this.calls.push({ op: 'pressKey', args: { windowId, keys } });
  }
  async launchApp(appId: string): Promise<void> {
    this.calls.push({ op: 'launchApp', args: { appId } });
  }
  async readFile(path: string): Promise<string> {
    this.calls.push({ op: 'readFile', args: { path } });
    return `contents of ${path}`;
  }
  private hotkeys = new Map<string, () => void>();
  async watchHotkey(chord: string, cb: () => void): Promise<() => void> {
    this.calls.push({ op: 'watchHotkey', args: { chord } });
    this.hotkeys.set(chord, cb);
    return () => {
      this.hotkeys.delete(chord);
    };
  }
  /** Test helper: simulate the user pressing the chord. */
  fireHotkey(chord: string): void {
    this.hotkeys.get(chord)?.();
  }
}

/** Pick the best driver for the current machine, or undefined. */
export async function detectDriver(): Promise<NativeDriver | undefined> {
  const candidates: NativeDriver[] = [new WindowsPowerShellDriver(), new LinuxX11Driver()];
  for (const driver of candidates) {
    if (await driver.available()) return driver;
  }
  return undefined;
}
