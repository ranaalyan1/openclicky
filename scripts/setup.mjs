#!/usr/bin/env node
/**
 * One-command setup: `npm run setup`.
 *
 * Does exactly what a brand-new machine needs, in order, and is safe to re-run:
 *
 *   1. checks the Node version
 *   2. installs every dependency            (npm install, only when missing)
 *   3. compiles the workspace               (npm run build, only when stale)
 *   4. asks for the two keys and verifies them live
 *      KEY 1 · model   — required, any OpenAI-compatible endpoint
 *      KEY 2 · search  — Brave Search, optional (DuckDuckGo fallback)
 *
 * The same script backs install.sh and install.ps1, so every entry point
 * behaves identically.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;

function fail(message, hint) {
  console.error(`\n${red('✗')} ${message}`);
  if (hint) console.error(dim(hint));
  process.exit(1);
}

function run(cmd, args, label) {
  console.log(`${dim('→')} ${label}`);
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status})`, `Run it yourself to see the details: ${cmd} ${args.join(' ')}`);
}

/* ---------------- 1. node version ---------------- */

const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 18) {
  fail(
    `Node ${process.versions.node} is too old — OpenClicky needs Node 18 or newer (20+ recommended).`,
    'Install it from https://nodejs.org (LTS) and run setup again.',
  );
}
console.log(`${green('✓')} node ${process.versions.node}`);

/* ---------------- 2. dependencies ---------------- */

const hasModules = fs.existsSync(path.join(root, 'node_modules'));
const skipSetup = process.env.OPENCLICKY_SKIP_SETUP === '1';

if (!hasModules) {
  run(npm, ['install', '--no-audit', '--no-fund'], 'installing dependencies (first run takes a minute)');
} else {
  console.log(`${green('✓')} dependencies already installed ${dim('(rm -rf node_modules to force)')}`);
}

/* ---------------- 3. build ---------------- */

const wizardEntry = path.join(root, 'cli', 'dist', 'main.js');
const coreEntry = path.join(root, 'core', 'dist', 'src', 'index.js');

if (!fs.existsSync(wizardEntry) || !fs.existsSync(coreEntry)) {
  run(npm, ['run', 'build'], 'compiling the workspace');
} else {
  console.log(`${green('✓')} workspace compiled`);
}

if (skipSetup) {
  console.log(dim('\nOPENCLICKY_SKIP_SETUP=1 — skipping the two-key wizard.'));
  process.exit(0);
}

/* ---------------- 4. the two keys ---------------- */

if (!process.stdin.isTTY && process.env.OPENCLICKY_FORCE_SETUP !== '1') {
  console.log(
    `\n${bold('Almost there.')} This shell is not interactive, so the key wizard was skipped.\n` +
      `  Run ${bold('npm run setup')} in a terminal to enter the two keys:\n` +
      `    KEY 1 · model   — any OpenAI-compatible key (required)\n` +
      `    KEY 2 · search  — Brave Search (optional, DuckDuckGo fallback)\n`,
  );
  process.exit(0);
}

const wizard = spawnSync(process.execPath, [wizardEntry, 'setup'], { cwd: root, stdio: 'inherit' });
process.exit(wizard.status ?? 0);
