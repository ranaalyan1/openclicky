/**
 * Onboarding — the two-key setup every new user goes through.
 *
 * OpenClicky needs exactly two APIs:
 *
 *   KEY 1 · MODEL   the brain. Any OpenAI-compatible endpoint.
 *   KEY 2 · SEARCH  Brave Search. Real results for web.search.
 *                   Optional: without it we fall back to DuckDuckGo.
 *
 * This module holds the shared pieces — provider presets and live key
 * verification — so the CLI wizard, the panel setup card and the installer
 * script all behave identically.
 */

import { braveSearch, type FetchLike } from './search.js';

export interface ProviderPreset {
  id: string;
  label: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  /** Sensible default model for this provider. */
  model: string;
  /** Where the user gets a key. */
  keyUrl: string;
  /** Free-form hint shown in the wizard. */
  hint: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'paid, best all-round quality',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'one key, hundreds of models, some free',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'free tier, very fast',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    keyUrl: 'https://ollama.com/download',
    hint: 'free, fully offline — key can be any placeholder',
  },
  {
    id: 'custom',
    label: 'Custom / self-hosted',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: '',
    hint: 'any OpenAI-compatible base URL',
  },
] as const;

/** Brave Search dashboard — where key #2 comes from. */
export const SEARCH_KEY_URL = 'https://api-dashboard.search.brave.com/app/keys';
export const SEARCH_PRESET = {
  label: 'Brave Search',
  freeTier: 'free tier: 2,000 queries/month, no card needed',
};

export interface VerifyResult {
  ok: boolean;
  /** Human-readable one-liner for the wizard / panel. */
  detail: string;
}

export interface VerifyModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

/**
 * Prove key #1 works by making the smallest possible real completion.
 * Distinguishes "bad key" (401/403) from "bad model" (404) from
 * "endpoint unreachable", because each needs a different fix from the user.
 */
export async function verifyModelKey(opts: VerifyModelOptions): Promise<VerifyResult> {
  const base = (opts.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return { ok: false, detail: 'base URL must start with http:// or https://' };
  if (!opts.apiKey?.trim()) return { ok: false, detail: 'no API key given' };
  if (!opts.model?.trim()) return { ok: false, detail: 'no model name given' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await (opts.fetchFn ?? fetch)(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: opts.model.trim(),
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { choices?: unknown[] };
      if (Array.isArray(data.choices) && data.choices.length > 0) {
        return { ok: true, detail: `${opts.model.trim()} replied — key works` };
      }
      return { ok: false, detail: 'endpoint answered but sent no completions — check the base URL' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `key rejected (${res.status}) — check you pasted the whole key` };
    }
    if (res.status === 404) {
      return { ok: false, detail: `model "${opts.model.trim()}" not found at this endpoint (404) — check the model name` };
    }
    if (res.status === 429) {
      return { ok: true, detail: 'key works, but you are rate-limited right now (429)' };
    }
    const text = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, detail: `endpoint error ${res.status}${text ? `: ${text}` : ''}` };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
    return { ok: false, detail: `could not reach ${base} — ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifySearchOptions {
  apiKey: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

/** Prove key #2 works with one cheap Brave query. */
export async function verifySearchKey(opts: VerifySearchOptions): Promise<VerifyResult> {
  const key = opts.apiKey?.trim();
  if (!key) return { ok: false, detail: 'no search key given' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const hits = await braveSearch('openclicky', {
      apiKey: key,
      count: 1,
      fetchFn: opts.fetchFn,
    });
    return hits.length > 0
      ? { ok: true, detail: `Brave returned ${hits.length} result${hits.length === 1 ? '' : 's'} — key works` }
      : { ok: false, detail: 'Brave answered with no results — key may be rate-limited' };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
    if (/401|403/.test(msg)) return { ok: false, detail: `search key rejected (${msg}) — check the Brave dashboard` };
    return { ok: false, detail: `search check failed — ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Which key is still missing, in the order the user should supply them. */
export interface OnboardingState {
  needsModelKey: boolean;
  needsSearchKey: boolean;
  complete: boolean;
}

export function onboardingState(settings: { apiKey: string; searchApiKey: string }): OnboardingState {
  const needsModelKey = settings.apiKey.trim().length === 0;
  const needsSearchKey = settings.searchApiKey.trim().length === 0;
  return { needsModelKey, needsSearchKey, complete: !needsModelKey && !needsSearchKey };
}

/** Lines the wizard/README print so a newcomer knows what to do. */
export function onboardingChecklist(state: OnboardingState): string[] {
  return [
    state.needsModelKey
      ? '[ ] KEY 1 · model   — required. Any OpenAI-compatible key (OpenAI, OpenRouter, Groq, Ollama).'
      : '[x] KEY 1 · model   — saved.',
    state.needsSearchKey
      ? `[ ] KEY 2 · search  — recommended. Brave Search, ${SEARCH_PRESET.freeTier}. Keyless DuckDuckGo until then.`
      : '[x] KEY 2 · search  — saved.',
  ];
}
