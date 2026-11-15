/**
 * The two-key setup wizard — `openclicky setup`.
 *
 *   KEY 1 · MODEL   the brain (any OpenAI-compatible endpoint)  [required]
 *   KEY 2 · SEARCH  Brave Search (web.search results)           [recommended]
 *
 * Both are verified live before they are saved, so a newcomer never ends up
 * with a saved-but-broken key. Everything is written to one per-user config
 * file with mode 0600; env vars still win at load time.
 */

import * as readline from 'node:readline/promises';

import {
  PROVIDER_PRESETS,
  SEARCH_KEY_URL,
  SEARCH_PRESET,
  loadSettings,
  maskApiKey,
  saveSettings,
  settingsPath,
  verifyModelKey,
  verifySearchKey,
  type OpenClickySettings,
} from '@openclicky/core';

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

export interface WizardOptions {
  /** Where to write the config (defaults to the per-user path). */
  file?: string;
  /** Non-interactive answers, used by --yes / tests. */
  answers?: Partial<{
    preset: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    searchApiKey: string;
  }>;
}

export async function runSetupWizard(opts: WizardOptions = {}): Promise<OpenClickySettings> {
  const file = opts.file ?? settingsPath();
  const current = loadSettings(process.env, file);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // EOF (piped/closed stdin) must never leave a prompt hanging: every question
  // then falls through to its default so an unattended run still exits cleanly.
  let stdinClosed = false;
  rl.on('close', () => {
    stdinClosed = true;
  });
  // A question must always settle. On EOF (piped or closed stdin) it resolves
  // with its default, so an unattended `curl | bash` install never hangs.
  const ask = (q: string, fallback = ''): Promise<string> =>
    new Promise<string>((resolve) => {
      if (stdinClosed) return resolve(fallback);
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        rl.off('close', onClose);
        resolve(value.trim().length > 0 ? value.trim() : fallback);
      };
      const onClose = () => finish(fallback);
      rl.once('close', onClose);
      rl.question(q).then(finish).catch(() => finish(fallback));
    });

  const a = opts.answers ?? {};

  try {
    console.log('');
    console.log(`${BOLD}OpenClicky setup${RESET} ${DIM}— two keys, about a minute${RESET}`);
    console.log(`${DIM}config: ${file}${RESET}`);
    console.log('');

    /* ---------------- KEY 1 · MODEL ---------------- */
    console.log(`${BOLD}KEY 1 · MODEL${RESET} ${DIM}(required — the brain)${RESET}`);
    PROVIDER_PRESETS.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.label.padEnd(20)} ${DIM}${p.hint}${RESET}`);
    });
    const pick = a.preset ?? (await ask(`\nChoose 1-${PROVIDER_PRESETS.length} [1]: `, '1'));
    const index = Math.min(Math.max(Number.parseInt(pick, 10) || 1, 1), PROVIDER_PRESETS.length) - 1;
    const preset = PROVIDER_PRESETS[index];
    if (preset.keyUrl) console.log(`${DIM}get a key: ${preset.keyUrl}${RESET}`);

    const baseUrl = a.baseUrl ?? (await ask(`Base URL [${preset.baseUrl}]: `, preset.baseUrl));
    const model = a.model ?? (await ask(`Model [${preset.model}]: `, preset.model));

    let apiKey = a.apiKey ?? '';
    if (!apiKey) {
      const saved = current.apiKey ? `${DIM}saved (${maskApiKey(current.apiKey)}) — press Enter to keep${RESET}` : '';
      if (saved) console.log(saved);
      apiKey = await ask('Model API key: ', current.apiKey);
    }

    if (!apiKey) {
      console.log(`${RED}No model key given — OpenClicky cannot think without it.${RESET}`);
      const partial = saveSettings({ baseUrl, model }, file);
      return partial;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      process.stdout.write(`${DIM}checking key 1…${RESET}`);
      const res = await verifyModelKey({ baseUrl, apiKey, model });
      process.stdout.write('\r\u001b[K');
      if (res.ok) {
        console.log(`${GREEN}✓ key 1${RESET} ${res.detail}`);
        break;
      }
      console.log(`${YELLOW}!${RESET} ${res.detail}`);
      if (attempt === 3) {
        const keep = (await ask('Save it anyway? (y/N): ', 'n')).toLowerCase();
        if (!keep.startsWith('y')) {
          console.log(`${DIM}saving nothing. Re-run "openclicky setup" any time.${RESET}`);
          return saveSettings({ baseUrl, model }, file);
        }
        break;
      }
      apiKey = await ask('Model API key (Enter to retry the same one): ', apiKey);
    }

    /* ---------------- KEY 2 · SEARCH ---------------- */
    console.log('');
    console.log(`${BOLD}KEY 2 · SEARCH${RESET} ${DIM}(recommended — ${SEARCH_PRESET.freeTier})${RESET}`);
    console.log(`${DIM}get one: ${SEARCH_KEY_URL}${RESET}`);
    console.log(`${DIM}press Enter to skip — web.search then uses keyless DuckDuckGo${RESET}`);

    let searchApiKey = a.searchApiKey ?? (await ask('Brave Search API key: ', current.searchApiKey));
    let searchProvider: OpenClickySettings['searchProvider'] = searchApiKey ? 'auto' : 'duckduckgo';

    if (searchApiKey) {
      process.stdout.write(`${DIM}checking key 2…${RESET}`);
      const res = await verifySearchKey({ apiKey: searchApiKey });
      process.stdout.write('\r\u001b[K');
      if (res.ok) {
        console.log(`${GREEN}✓ key 2${RESET} ${res.detail}`);
      } else {
        console.log(`${YELLOW}!${RESET} ${res.detail}`);
        const keep = (await ask('Save it anyway? (y/N): ', 'n')).toLowerCase();
        if (!keep.startsWith('y')) {
          searchApiKey = '';
          searchProvider = 'duckduckgo';
          console.log(`${DIM}search stays on DuckDuckGo.${RESET}`);
        }
      }
    } else {
      console.log(`${DIM}skipped — DuckDuckGo fallback active.${RESET}`);
    }

    const saved = saveSettings({ baseUrl, model, apiKey, searchApiKey, searchProvider }, file);

    console.log('');
    console.log(`${GREEN}${BOLD}Ready.${RESET}`);
    console.log(`  ${BOLD}panel${RESET}   npm start          ${DIM}→ http://127.0.0.1:4747${RESET}`);
    console.log(`  ${BOLD}terminal${RESET} npm run chat      ${DIM}(or: npx openclicky)${RESET}`);
    console.log(
      `  ${BOLD}search${RESET}   ${saved.searchApiKey ? 'Brave Search' : 'DuckDuckGo (keyless)'}`,
    );
    console.log('');
    return saved;
  } finally {
    rl.close();
  }
}
