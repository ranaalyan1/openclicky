/**
 * Settings — where the model config lives for non-developers.
 *
 * Resolution order (env wins, then file, then defaults):
 *   OPENCLICKY_MODEL_BASE_URL / OPENCLICKY_MODEL_KEY / OPENCLICKY_MODEL /
 *   OPENCLICKY_VISION / OPENCLICKY_SEARCH_KEY / OPENCLICKY_SEARCH_PROVIDER
 *   → config file (below) → built-in defaults.
 *
 * There are exactly two keys in OpenClicky:
 *   1. the model key   (the brain — any OpenAI-compatible endpoint)
 *   2. the search key  (Brave Search — real web results for web.search;
 *      optional, DuckDuckGo is the keyless fallback)
 *
 * The config file is written mode-0600 (owner-only) at:
 *   OPENCLICKY_CONFIG   if set
 *   %APPDATA%\openclicky\config.json           on Windows
 *   $XDG_CONFIG_HOME/openclicky/config.json    on Linux/macOS (or ~/.config)
 *
 * Saving only ever touches the file — environment variables always override
 * it at load time, so dev shells stay in charge when both exist.
 */

import type { SearchProvider } from './search.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface OpenClickySettings {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Model name, e.g. gpt-4o-mini */
  model: string;
  /** API key; may be empty until the user onboards. */
  apiKey: string;
  /** Attach screenshots as vision parts (default true). */
  vision: boolean;
  /** Brave Search API key (key #2). Empty = keyless DuckDuckGo fallback. */
  searchApiKey: string;
  /** Which search engine `web.search` uses. */
  searchProvider: SearchProvider;
}

export const DEFAULT_SETTINGS: OpenClickySettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  vision: true,
  searchApiKey: '',
  searchProvider: 'auto',
};

type ConfigFileShape = Partial<
  Record<'baseUrl' | 'model' | 'apiKey' | 'vision' | 'searchApiKey' | 'searchProvider', unknown>
>;

const SEARCH_PROVIDERS: readonly SearchProvider[] = ['auto', 'brave', 'duckduckgo'];

function asProvider(v: unknown): SearchProvider | undefined {
  return typeof v === 'string' && (SEARCH_PROVIDERS as readonly string[]).includes(v) ? (v as SearchProvider) : undefined;
}

/** Resolve the config file location (settings are per-user). */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLICKY_CONFIG) return env.OPENCLICKY_CONFIG;
  if (process.platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'openclicky', 'config.json');
  }
  const xdg = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'openclicky', 'config.json');
}

function readFileSettings(file: string): ConfigFileShape {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ConfigFileShape;
  } catch {
    return {};
  }
}

/** Env → file → defaults. Guaranteed to return a complete settings object. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, file: string = settingsPath(env)): OpenClickySettings {
  const f = readFileSettings(file);
  const visionEnv = env.OPENCLICKY_VISION;
  return {
    baseUrl: env.OPENCLICKY_MODEL_BASE_URL ?? (typeof f.baseUrl === 'string' ? f.baseUrl : DEFAULT_SETTINGS.baseUrl),
    model: env.OPENCLICKY_MODEL ?? (typeof f.model === 'string' ? f.model : DEFAULT_SETTINGS.model),
    apiKey: env.OPENCLICKY_MODEL_KEY ?? (typeof f.apiKey === 'string' ? f.apiKey : DEFAULT_SETTINGS.apiKey),
    vision: visionEnv !== undefined ? visionEnv !== '0' : typeof f.vision === 'boolean' ? f.vision : DEFAULT_SETTINGS.vision,
    searchApiKey:
      env.OPENCLICKY_SEARCH_KEY ??
      (typeof f.searchApiKey === 'string' ? f.searchApiKey : DEFAULT_SETTINGS.searchApiKey),
    searchProvider:
      asProvider(env.OPENCLICKY_SEARCH_PROVIDER) ??
      asProvider(f.searchProvider) ??
      DEFAULT_SETTINGS.searchProvider,
  };
}

export interface SaveSettingsInput {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  vision?: boolean;
  searchApiKey?: string;
  searchProvider?: SearchProvider;
}

/** Normalize sloppy input so the file on disk is always clean. */
function normalize(update: SaveSettingsInput): SaveSettingsInput {
  const out: SaveSettingsInput = { ...update };
  if (out.baseUrl !== undefined) out.baseUrl = out.baseUrl.trim().replace(/\/+$/, '');
  if (out.model !== undefined) out.model = out.model.trim();
  if (out.apiKey !== undefined) out.apiKey = out.apiKey.trim();
  if (out.searchApiKey !== undefined) out.searchApiKey = out.searchApiKey.trim();
  return out;
}

/** Merge-and-write. Only provided fields change. Returns the new file state. */
export function saveSettings(update: SaveSettingsInput, file: string = settingsPath()): OpenClickySettings {
  const clean = normalize(update);
  const current = readFileSettings(file);
  const merged: OpenClickySettings = {
    baseUrl: clean.baseUrl ?? (typeof current.baseUrl === 'string' ? current.baseUrl : DEFAULT_SETTINGS.baseUrl),
    model: clean.model ?? (typeof current.model === 'string' ? current.model : DEFAULT_SETTINGS.model),
    apiKey: clean.apiKey ?? (typeof current.apiKey === 'string' ? current.apiKey : DEFAULT_SETTINGS.apiKey),
    vision: clean.vision ?? (typeof current.vision === 'boolean' ? current.vision : DEFAULT_SETTINGS.vision),
    searchApiKey:
      clean.searchApiKey ?? (typeof current.searchApiKey === 'string' ? current.searchApiKey : DEFAULT_SETTINGS.searchApiKey),
    searchProvider:
      asProvider(clean.searchProvider) ?? asProvider(current.searchProvider) ?? DEFAULT_SETTINGS.searchProvider,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

/** Never show a full key over the wire/UI. */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 6) return '••••••';
  return `${key.slice(0, 3)}••••${key.slice(-3)}`;
}

/** What the UI is allowed to see — never a raw key. */
export interface PublicSettings {
  baseUrl: string;
  model: string;
  vision: boolean;
  hasKey: boolean;
  keyPreview: string;
  hasSearchKey: boolean;
  searchKeyPreview: string;
  searchProvider: SearchProvider;
}

export function publicSettings(s: OpenClickySettings): PublicSettings {
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    vision: s.vision,
    hasKey: s.apiKey.length > 0,
    keyPreview: maskApiKey(s.apiKey),
    hasSearchKey: s.searchApiKey.length > 0,
    searchKeyPreview: maskApiKey(s.searchApiKey),
    searchProvider: s.searchProvider,
  };
}
