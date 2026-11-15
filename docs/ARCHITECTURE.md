# OpenClicky architecture

## Core (core/)

- `model.ts` — the only model boundary. OpenAI-compatible today; any
  OpenAI-compatible endpoint or local runtime works via config. Message
  content can be plain text or multimodal content parts (text + images).
- `registry.ts` — runtimes register and publish a `CapabilitySnapshot`; the
  registry converts `CommandSpec`s into model tool schemas automatically, so
  adding a device never touches the planner.
- `hitl.ts` — the approval engine. Gates: `AUTO`, `ASK_ONCE` (remembers
  `always:` grants), `ASK_ALWAYS`, `NEVER`. Sensitive argument values are
  redacted before display.
- `voice.ts` — speech adapters against any OpenAI-compatible audio endpoint
  (`/audio/transcriptions`, `/audio/speech`); local whisper.cpp/LM Studio
  servers work by config.
- `settings.ts` — zero-config onboarding. Resolution order: environment →
  per-user config file (mode 0600) → defaults, so the server boots without
  any env vars and the panel's setup card persists + hot-swaps the model
  adapter (`OpenAICompatibleAdapter.update`); the public view only ever
  exposes a masked key preview.
- `executor.ts` — the loop: model reply → tool calls → arg validation →
  HITL gate → runtime invoke → results back to the model, until a plain
  answer emerges. Step-limited; unknown tools and invalid arguments are
  reported to the model, not guessed. Image results (screenshots) are
  re-attached as user-role vision content parts after the tool messages, so
  multimodal models actually see the screen (`vision: false` opts out).

## Runtimes

- `pc-host` — HeyClicky/Dots actuator contract: screenshot (real PNG pixels,
  attached to the conversation as vision parts), screen info, list/active
  windows, click (button + multi-click), scroll, type, press, launch,
  file read. Native drivers: PowerShell/.NET on Windows (zero deps),
  xdotool/wmctrl/ImageMagick on X11 Linux, FakeDriver for tests and dry
  runs. Indexed a11y clicking (Dots pattern) works today via UIAutomation
  on Windows — `pc.a11y_tree` snapshots indexed elements and `pc.click`
  takes an `elementIndex`; AT-SPI bindings for Linux are next.
- `sandbox-browser` — Grok Bot/Muse isolation contract + worker: navigate,
  click, type, a11y state, search. The reader tier (fetch/search) runs
  anywhere; the actor tier uses the `sandbox/` Playwright worker (stdio
  protocol, Dockerfile), with live-view viewport frames and
  takeover/release/cancel control.
- `connectors` — third-party APIs behind scoped credentials: API-key or
  OAuth2-PKCE auth, tokens in an AES-256-GCM vault, calls restricted to the
  connector's origin + allowed path prefixes.
- `android` — Muse/Hatch-style catalog (info, screenshot, tap, swipe, text,
  keys, app launch) over an ADB bridge today; the companion-app bridge is
  its own milestone.

## Protocol (protocol/openclicky/v1)

Envelope + capability snapshot + command invocation + HITL + events.
The .proto files are the source of truth; TypeScript mirrors them until
codegen is wired in.

## Milestones

1. Protocol + core + CLI + tests — done
2. PC host native backends — done (PowerShell/.NET on Windows, X11 tools on
   Linux, UIA a11y indexing on Windows); AT-SPI a11y + hotkeys next
3. Sandbox browser worker — done (Playwright engine, frames, takeover);
   container live-stream UI next
4. Android runtime — ADB bridge done; companion app (WS protocol,
   notifications/geofence) next
5. Connector gateway — done (API key + OAuth2 PKCE + encrypted vault);
   curated connector catalog next
6. Voice — done through the panel (STT + TTS); duplex talk mode next
7. Multi-device session handoff + proactive backfill polish
8. Signed installers + auto-update
