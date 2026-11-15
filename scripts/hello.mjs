#!/usr/bin/env node
/**
 * postinstall greeting — never blocks, never fails an install.
 *
 * The key wizard deliberately does NOT run here: prompts inside `npm install`
 * hang CI and confuse package managers. Instead the installer (install.sh /
 * install.ps1) and `npm run setup` drive it in a normal terminal.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const bold = (s) => `\u001b[1m${s}\u001b[0m`;

function configPath() {
  if (process.env.OPENCLICKY_CONFIG) return process.env.OPENCLICKY_CONFIG;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'openclicky', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'openclicky', 'config.json');
}

try {
  const file = configPath();
  let configured = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    configured = typeof cfg.apiKey === 'string' && cfg.apiKey.trim().length > 0;
  } catch {
    configured = false;
  }

  if (configured) {
    console.log(`${dim('OpenClicky is ready — npm start (panel) or npm run chat (terminal).')}`);
  } else {
    console.log('');
    console.log(`${bold('OpenClicky needs two keys before it can think:')}`);
    console.log('  KEY 1 · model   any OpenAI-compatible key        (required)');
    console.log('  KEY 2 · search  Brave Search, free tier available (optional)');
    console.log(`${dim('Run: npm run setup')}`);
    console.log('');
  }
} catch {
  /* a greeting must never break an install */
}
