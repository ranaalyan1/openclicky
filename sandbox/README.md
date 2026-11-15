# Sandbox browser worker

Browser and heavy tasks run in ephemeral, disposable workers — the Grok Bot
per-bot-container pattern, with Muse's live-view + takeover UX.

## What this package is

`@openclicky/sandbox` is the actor-tier engine for `web.click` / `web.type` /
`web.state`: a Playwright-driven Chromium that lives off the host, speaks the
OpenClicky protocol (JSON lines over stdio today; the envelope schema is in
`protocol/openclicky/v1`), streams `viewport` frames after every action, and
honors `takeover` / `release` / `cancel` control commands.

## Run it locally (no container)

```bash
npm install
npx playwright install chromium
npm run build -w @openclicky/core -w @openclicky/sandbox
OPENCLICKY_SANDBOX_HEADFUL=1 npm start -w @openclicky/sandbox   # visible browser for takeover
```

Then feed it JSON lines, e.g.:

```json
{"id":"1","method":"snapshot"}
{"id":"2","method":"invoke","params":{"invocationId":"i1","commandId":"web.state","commandVersion":"v1","args":{}}}
{"id":"3","method":"invoke","params":{"invocationId":"i2","commandId":"web.click","commandVersion":"v1","args":{"elementIndex":{"kind":"number","value":0}}}}
{"id":"4","method":"control","params":{"action":"takeover","taskId":"t1"}}
```

## Container

```bash
docker build -f sandbox/Dockerfile -t openclicky-sandbox .   # context = repo root
docker run --rm -i openclicky-sandbox
```

No host mounts, no host credentials, per-task lifetime. The core attaches a
worker via `BrowserSandboxRuntime({ actor })` — see core
`BrowserSandboxOptions`.
