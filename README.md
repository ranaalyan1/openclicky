# OpenClicky

**One open-source AI agent that sees and acts across your PC, the web, and your phone.**

OpenClicky is a clean-room agent built from scratch, combining the best
architectural patterns we extracted from reverse-engineering four
production agents — HeyClicky, OpenAI Dots, Grok Bot, and Meta's Muse
(see [`docs/CAPABILITY-MAP.md`](docs/CAPABILITY-MAP.md) for exactly what
each one contributed).

```
                     ┌───────────────────────────┐
                     │      OPENCLICKY CORE      │
                     │  model-agnostic executor  │
                     │  typed tool registry      │
                     │  HITL approval engine      │
                     │  proactive triggers        │
                     └────────────┬──────────────┘
                  one typed protocol (protocol/*.proto)
        ┌───────────────┬─────────┴────────┬───────────────┐
   ┌────┴─────┐   ┌─────┴─────┐   ┌──────────┴──┐   ┌────────┴───┐
   │ PC HOST  │   │ BROWSER   │   │ ANDROID     │   │ CONNECTOR  │
   │ capture, │   │ SANDBOX   │   │ RUNTIME    │   │ GATEWAY    │
   │ input,   │   │ (isolated │   │ (planned)   │   │ (planned)  │
   │ a11y     │   │  workers) │   │             │   │            │
   └──────────┘   └───────────┘   └─────────────┘   └────────────┘
```

## Design rules (hard-won from four RE studies)

1. **Typed, versioned commands** — every capability is a `CommandSpec` with
   `v1`-style versions. No free-form shell strings, ever.
2. **The core plans only against advertised capabilities** — runtimes
   publish a `CapabilitySnapshot`; unknown tools are rejected, not guessed.
3. **HITL gates are protocol objects** — sensitive actions (typing, clicking,
   sending) carry an approval mode (`AUTO` / `ASK_ONCE` / `ASK_ALWAYS` /
   `NEVER`), surface a redacted approval card, and record scoped grants.
4. **Browser and heavy work runs in disposable sandboxes** — never on your
   host; live-viewable and take-over-able (arriving with the worker).
5. **Model-agnostic** — any OpenAI-compatible endpoint; local models are a
   config change, not a rewrite.
6. **Web content is data, never instructions** — standard anti-injection
   posture baked into the system prompt and approval rules.

## Install (one command, two keys)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ranaalyan1/openclicky/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/ranaalyan1/openclicky/main/install.ps1 | iex
```

The installer checks Node 18+, downloads the source, installs every dependency,
compiles the workspace, and then asks for **the two keys** — each one tested
live before it is saved:

| Key | What | Required? | Where |
|---|---|---|---|
| **1 · model** | the brain. Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, or Ollama/LM Studio locally | **yes** | panel card / wizard |
| **2 · search** | Brave Search for `web.search` (free tier: 2,000 queries/month) | recommended | [get one](https://api-dashboard.search.brave.com/app/keys) |

Key 2 is optional on purpose: without it `web.search` falls back to keyless
DuckDuckGo, so the agent still reads the web. Keys live in one file
(`%APPDATA%\openclicky\config.json` on Windows, `~/.config/openclicky/config.json`
elsewhere) written mode `0600`; the UI only ever sees masked previews, and env
vars (`OPENCLICKY_MODEL_KEY`, `OPENCLICKY_SEARCH_KEY`) still win when set.

Re-key any time:

```bash
npm run setup        # or: npx openclicky setup
```

Working from a clone instead:

```bash
git clone https://github.com/ranaalyan1/openclicky.git
cd openclicky
npm install && npm run setup      # asks for the two keys
npm start                          # panel → http://127.0.0.1:4747
npm run chat                        # terminal client
```

## The interface

OpenClicky's panel is the HeyClicky look: a dark, compact, floating window you
park in a corner. Chat, live command results, and click-to-approve HITL cards
(Yes / Always / No) all in one pane. In the Electron overlay it behaves like
a real product: frameless and transparent, **drag it by the header**, **pin
it** to stay always-on-top, it hides to the **system tray** instead of
quitting (tray menu: show/hide, launch-at-login, quit), and only one
instance runs at a time. First launch opens the two-key setup card — model
endpoint and key, then the Brave Search key — each with a **Test keys** button
that pings the provider before anything is saved.

```bash
# browser mode
npm run start          # → http://localhost:4747

# floating overlay (Clicky-style, frameless + always-on-top)
cd apps/desktop && npm install && npm start
```

The panel talks to the agent over REST + SSE — the same HITL engine as the
CLI, so nothing can act on your machine without the card being approved.

## The PC agent on a real machine

The pc-host runtime talks to real native drivers today:

- **Windows 10+** — nothing to install. The driver uses PowerShell + .NET
  (Win32 `SetCursorPos`/`mouse_event`, `SendKeys`, `System.Drawing` capture).
- **Linux (X11)** — `sudo apt install xdotool wmctrl imagemagick x11-apps`.

Command catalog (all `v1`; HITL gate in parens):

| Command | Gate | What it does |
|---|---|---|
| `pc.screen_info` | auto | Screen size + DPI scale — the click coordinate space |
| `pc.screenshot` | auto | PNG of the desktop, attached as an image the model can see |
| `pc.a11y_tree` | auto | Indexed interactive elements (UIA on Windows) — robust click targets |
| `pc.get_active_window` | auto | Focused window title/app |
| `pc.list_windows` | auto | All open windows with ids |
| `pc.click` | ask | `elementIndex` (from `pc.a11y_tree`) or coordinates + `button` / `clicks` |
| `pc.scroll` | ask | Mouse wheel, `dx`/`dy` in notches |
| `pc.type_text` | ask | Types into the focused window |
| `pc.press_key` | ask | Key chords (`"ctrl+s"`) |
| `pc.launch_app` | ask once | Start an application |
| `pc.files.read` | ask | Read a text file (truncated) |

The system prompt teaches the model the working loop: `screen_info` →
`screenshot` → plan coordinates from what it sees → act → re-screenshot to
verify. Try: *"open notepad and type a haiku about sandboxed agents"*.

## HeyClicky compatibility

OpenClicky is a **clean-room** implementation: none of HeyClicky's code is
copied. Theirs is proprietary Windows C#/WinUI with a server-side brain; this
repo is MIT TypeScript you run yourself. What OpenClicky *does* match is the
surface HeyClicky's model and clients expect, transcribed from the de-linked
study copy:

- **Tool names and call shapes** — `browser` (`open`, `snapshot`, `click`,
  `fill`, `search`, …) and `mac_step`, accepting both the flat
  `{action:'open', url}` and the single-key `{open:{url}}` forms. See
  [`core/src/compat/heyclicky.ts`](core/src/compat/heyclicky.ts) and the
  generated [`docs/HEYCLICKY-COMPAT.md`](docs/HEYCLICKY-COMPAT.md).
- **Transport** — `POST /brain/turn` speaks HeyClicky's own turn route (SSE
  `text` then `done`), so a Clicky-style client can point at OpenClicky
  unchanged. Approvals still flow through `/api/approvals`.
- **Semantics** — wait-bounded calls that report what happened, DOM state as
  `role: name [ref]` lines, and an explicit rule that after a timeout the
  outcome is unknown: look before acting, never repeat.

Everything HeyClicky does that this build cannot do yet is listed as `absent`
in the mapping table and refused at runtime with the alternative named — a
phantom tool is never silently accepted. That table is the single source of
truth; `npm run docs:compat` regenerates the doc from it.

### Provenance

HeyClicky is proprietary software. Its decompiled study copy lives in a
**private** repo for architecture study only and is not licensed for reuse, so
it is not, and will not be, the base of this project or published here. What
carries over is behaviour we re-implemented: the tool surface above, the four
execution surfaces (voice/brain, coding agent, background job runtime, browser),
and the patterns in [`docs/CAPABILITY-MAP.md`](docs/CAPABILITY-MAP.md).

## Safety defaults

- The panel server binds to **loopback only** (`127.0.0.1`). The API resolves
  approvals, so it is effectively a second keyboard: to share it beyond your
  machine set `OPENCLICKY_HOST=0.0.0.0` *and* `OPENCLICKY_TOKEN=<secret>`, which
  makes every `/api/*` call require `Authorization: Bearer <secret>`.
- Every click, keystroke, and file read passes an approval card; `always:`
  grants live only for the process lifetime and are never written to disk.
- Screenshots are sent to your model endpoint as images — that is the point
  of a vision agent, so be deliberate about where your model runs. For
  text-only models, set `OPENCLICKY_VISION=0` to keep results as plain text.

## Status

- [x] Protocol v1 (`protocol/openclicky/v1/*.proto` + TS mirror)
- [x] Core: executor loop, tool registry, HITL engine, model adapter
- [x] Vision path — screenshots reach the model as image content parts
- [x] CLI with terminal approvals
- [x] Clicky-style panel (web + Electron overlay) — SSE, approvals, mic-in/speak-out voice
- [x] Zero-config onboarding — first-run setup card, per-user config file, hot-swapped model, tray + pin overlay
- [x] Two-key onboarding — installer + wizard + panel card, live key verification, `npm run setup`
- [x] HeyClicky surface compatibility — `browser`/`mac_step` tool aliases, `/brain/turn`, generated mapping doc
- [x] Tests (73) — tool loop, HITL gating + grants, redaction, arg validation, vision attach, a11y clicking, PC session, triggers, connectors, Android, voice, settings precedence/hot-swap, server bridge + token auth
- [x] PC host native drivers — Windows (PowerShell/.NET) + Linux (X11 tools)
- [x] A11y-indexed clicking — UIAutomation on Windows (AT-SPI on Linux next)
- [x] Browser sandbox worker (`sandbox/`) — Playwright engine, viewport frames, takeover/release/cancel, Dockerfile
- [x] Proactive triggers — `pc.files.watch` everywhere, `pc.hotkey.listen` on Windows; events wake the agent
- [x] Connector gateway — API-key + OAuth2 PKCE, AES-256-GCM vault, origin/path scope enforcement
- [x] Android runtime — Hatch-style catalog over ADB bridge (companion app next)
- [x] Shipping — CI on PRs; tagged builds produce a Windows NSIS installer
- [ ] Linux AT-SPI a11y + hotkey bindings
- [ ] Android companion app (notifications/geofence over WS protocol)
- [ ] Duplex voice + multi-device session handoff

## Repository layout

```
protocol/     .proto source of truth (core and every runtime speak it)
core/         agent brain + HITL + runtimes (pc, browser, connectors, android) + voice
cli/          terminal client
apps/server   REST + SSE bridge serving the panel (+ voice endpoints)
apps/web      the Clicky-style panel (vanilla JS, mic button, approval cards)
apps/desktop  Electron overlay (floating, always-on-top) + installer packaging
sandbox/      disposable Playwright browser worker (protocol over stdio, Dockerfile)
docs/         architecture + capability map from the RE studies
```

## License

MIT © 2026 Muhammad Alyan Ashraf
