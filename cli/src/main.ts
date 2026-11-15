/**
 * openclicky-cli — chat with your agent from the terminal.
 *
 *   npx openclicky            first run asks for the two keys, then chats
 *   npx openclicky setup      re-run the two-key wizard
 *
 * Env vars still work for automation:
 *   OPENCLICKY_MODEL_BASE_URL / OPENCLICKY_MODEL_KEY / OPENCLICKY_MODEL /
 *   OPENCLICKY_SEARCH_KEY
 */

import * as readline from 'node:readline/promises';
import { createAgent, loadSettings, OpenAICompatibleAdapter, PcHostRuntime, BrowserSandboxRuntime } from '@openclicky/core';
import { runSetupWizard } from './setup.js';

async function main(): Promise<void> {
  const command = process.argv[2];

  // `openclicky setup` → always run the wizard (re-key, switch provider).
  if (command === 'setup' || command === 'onboard') {
    await runSetupWizard();
    return;
  }

  // env vars → config file (saved by the wizard / the panel's setup card) → defaults.
  let settings = loadSettings();

  // First run: no key at all → walk the newcomer through the two keys instead
  // of dying with an error. Interactive terminals only.
  if (!settings.apiKey && process.stdin.isTTY) {
    settings = await runSetupWizard();
    // reload so env-file precedence is applied consistently
    settings = loadSettings();
  }
  if (!settings.apiKey) {
    console.error(
      'No model key configured yet.\n' +
        '  Run:  openclicky setup        (asks for the two keys)\n' +
        '  Or:   npm run setup\n' +
        '  Or set OPENCLICKY_MODEL_KEY / OPENCLICKY_MODEL_BASE_URL in the environment.',
    );
    process.exit(1);
  }

  const browser = new BrowserSandboxRuntime({
    searchApiKey: settings.searchApiKey,
    searchProvider: settings.searchProvider,
    onSearchFallback: (reason) => console.error(`[search] DuckDuckGo fallback: ${reason}`),
  });
  const agent = createAgent({
    model: new OpenAICompatibleAdapter({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model }),
    runtimes: [new PcHostRuntime(), browser],
    vision: settings.vision,
    events: {
      onAssistantMessage: (content) => {
        if (content) process.stdout.write(`\n${content}\n`);
      },
      onCommandResult: (ok, summary) => {
        process.stdout.write(`  [${ok ? 'ok' : 'fail'}] ${summary}\n`);
      },
      onApprovalRequest: async (req) => {
        console.log(`\nApproval needed: ${req.summary}`);
        for (const a of req.argSummaries) console.log(`  ${a.name} = ${a.preview}`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question('Approve? (y)es / (n)o / (a)lways: ')).trim().toLowerCase();
        rl.close();
        const approved = answer.startsWith('y') || answer.startsWith('a');
        return {
          requestId: req.requestId,
          invocationId: req.invocationId,
          approved,
          scope: answer.startsWith('a') ? `always:${req.commandId}` : 'once',
          decidedBy: 'cli-user',
          decidedAtMs: Date.now(),
        };
      },
    },
  });

  const summary = await agent.start();
  console.log(`OpenClicky is up.\n${summary}`);
  console.log(
    `search: ${browser.searchMode()}${settings.searchApiKey ? '' : ' (add key 2: openclicky setup)'}\n` +
      `Type a message, or 'quit' to exit.\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    const line = await rl.question('you > ');
    if (!line.trim()) continue;
    if (line.trim() === 'quit' || line.trim() === 'exit') break;
    try {
      const reply = await agent.send(line);
      if (!reply) console.log('(no textual reply — see action output above)');
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
    }
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
