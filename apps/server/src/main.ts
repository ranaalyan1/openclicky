/**
 * OpenClicky panel server entry — runs the agent and serves the Clicky-style
 * interface at http://localhost:4747
 *
 * No configuration needed to start: open the panel and the setup card asks
 * for the two keys once (model + Brave Search), saves them
 * (%APPDATA%/openclicky/config.json on Windows), and hot-swaps both without a
 * restart. Power users can still drive everything from env vars
 * (OPENCLICKY_MODEL_* / OPENCLICKY_SEARCH_KEY override the file).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserSandboxRuntime,
  createAgent,
  loadSettings,
  OpenAICompatibleAdapter,
  OpenAIVoiceAdapter,
  PcHostRuntime,
  publicSettings,
  saveSettings,
  settingsPath,
  verifyModelKey,
  verifySearchKey,
} from '@openclicky/core';
import { agentEventsFor, createOpenClickyServer, createUiBridge } from './createServer.js';

const PORT = Number(process.env.OPENCLICKY_PORT ?? 4747);
// Loopback by default: the API includes HITL approval resolution, so it is
// effectively a second keyboard. Set OPENCLICKY_HOST=0.0.0.0 to expose it, and
// pair that with OPENCLICKY_TOKEN so every /api/* call needs a bearer token.
const HOST = process.env.OPENCLICKY_HOST ?? '127.0.0.1';
const authToken = process.env.OPENCLICKY_TOKEN || undefined;

/**
 * Where are the panel assets? Dev repo (apps/web), a dist copy, or inside the
 * packaged Electron app (resources/app/apps/web): the compiled file lives at
 * apps/server/dist/src/main.js, so probe the plausible ancestors.
 */
function resolveWebRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OPENCLICKY_WEB_ROOT,
    path.join(here, '..', 'web'),            // built copy: apps/server/dist/web
    path.join(here, '..', '..', 'web'),      // dev repo: apps/web
    path.join(here, '..', '..', '..', 'web'), // packaged: resources/app/apps/web
    path.join(process.cwd(), 'apps', 'web'),  // cwd is the repo root / resources/app
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  throw new Error(`panel assets not found (looked in: ${candidates.join(', ')})`);
}

async function main(): Promise<void> {
  const settings = loadSettings();

  const adapter = new OpenAICompatibleAdapter({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  });

  const bridge = createUiBridge();
  // KEY 2 lives on the browser runtime: Brave when present, DuckDuckGo when not.
  const browser = new BrowserSandboxRuntime({
    searchApiKey: settings.searchApiKey,
    searchProvider: settings.searchProvider,
    onSearchFallback: (reason) =>
      bridge.broadcast('notice', { level: 'warn', text: `search downgraded to DuckDuckGo: ${reason}` }),
  });
  const agent = createAgent({
    model: adapter,
    runtimes: [new PcHostRuntime(), browser],
    events: agentEventsFor(bridge),
    vision: settings.vision,
  });

  // Voice follows the same endpoint; a lazy proxy lets settings hot-swap it.
  let voice = new OpenAIVoiceAdapter({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
  const audioProxy = {
    transcribe: (b: Buffer, mime: string) => voice.transcribe(b, mime),
    speak: (t: string) => voice.speak(t),
  };

  const webRoot = resolveWebRoot();
  const server = createOpenClickyServer({
    agent,
    webRoot,
    bridge,
    authToken,
    audio: audioProxy,
    verify: {
      model: (input) => verifyModelKey(input),
      search: (input) => verifySearchKey(input),
    },
    settings: {
      read() {
        return publicSettings({
          baseUrl: adapter.config.baseUrl,
          model: adapter.config.model,
          apiKey: adapter.config.apiKey,
          vision: settings.vision,
          searchApiKey: browser.searchMode() === 'brave' ? 'saved' : settings.searchApiKey,
          // NOTE: only a placeholder/preview is ever exposed via publicSettings,
          // so passing the live key here is safe (it is masked on the way out).
          searchProvider: settings.searchProvider,
        });
      },
      write(update) {
        // Persist (env vars override at load, so landing settings stay dev-safe)
        const saved = saveSettings(update, settingsPath());
        // Hot-swap the live model + voice + search without a restart.
        adapter.update({ baseUrl: saved.baseUrl, apiKey: saved.apiKey, model: saved.model });
        voice = new OpenAIVoiceAdapter({ baseUrl: saved.baseUrl, apiKey: saved.apiKey });
        browser.setSearch({ apiKey: saved.searchApiKey, provider: saved.searchProvider });
        settings.searchApiKey = saved.searchApiKey;
        settings.searchProvider = saved.searchProvider;
        return publicSettings({ ...saved, vision: settings.vision });
      },
    },
  });

  server.listen(PORT, HOST, () => {
    console.log(`OpenClicky panel: http://${HOST}:${PORT}`);
    if (!settings.apiKey) {
      console.log('No model key yet — the panel shows the two-key setup card (model + Brave Search).');
    } else if (!settings.searchApiKey) {
      console.log('Search key not set — web.search uses keyless DuckDuckGo. Add key 2 in the panel settings.');
    }
    if (authToken) console.log('API requires Authorization: Bearer $OPENCLICKY_TOKEN for /api/*');
    else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.warn('warning: serving beyond loopback without OPENCLICKY_TOKEN — anyone who can reach this port can approve actions.');
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
