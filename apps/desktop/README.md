# OpenClicky desktop overlay

The Clicky-style interface: a frameless, always-on-top floating panel with a
system-tray presence — a product, not a dev toy.

## What you get

- **First-run setup card** — model base URL, API key and model name, saved to
  your user config (`%APPDATA%\openclicky\config.json` on Windows). No
  environment variables, no Node.js knowledge. Change it anytime via the ⚙
  button.
- 396×620 frameless, transparent overlay — **drag by the header**, **📌 pin**
  to keep it always-on-top over your apps.
- **System tray icon** (Show/hide, Launch at login, Quit) — closing the
  window hides it to the tray instead of quitting.
- Single instance — a second launch just brings the panel back. External
  links open in your real browser, never inside the overlay.

## Dev

```bash
cd apps/desktop
npm install
npm start          # env vars optional now — set OPENCLICKY_MODEL_KEY etc., or use the setup card
```

It spawns the panel server (apps/server) through the Electron binary
(`ELECTRON_RUN_AS_NODE=1`) and loads the UI in the overlay window.

## Package an installer

```bash
# from the repo root, after npm install && npm run build
cd apps/desktop
npm run dist   # electron-builder → release/OpenClicky Setup <version>.exe
```

The packaged app bundles the server, web panel and core runtime under
`resources/app` — installed users do **not** need Node.js. CI does this for
tagged versions (`.github/workflows/release.yml`), attaching the exe to the
GitHub Release. The app icon lives in `build/icon.png`.
