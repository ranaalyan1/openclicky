#!/usr/bin/env node
/**
 * Regenerates docs/HEYCLICKY-COMPAT.md from the single source of truth
 * (core/src/compat/heyclicky.ts). Run after changing the mapping table:
 *
 *   npm run docs:compat
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { renderCompatDoc } = await import(path.join(root, 'core', 'dist', 'src', 'compat', 'heyclicky.js'));

const out = path.join(root, 'docs', 'HEYCLICKY-COMPAT.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, renderCompatDoc());
console.log(`wrote ${path.relative(root, out)}`);
