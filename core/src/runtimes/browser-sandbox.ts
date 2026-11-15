/**
 * Browser sandbox runtime — the Grok Bot / Muse pattern: web work happens
 * away from the host.
 *
 * Two tiers:
 *  - Reader tier (always available): real fetch + search + text extraction
 *    with zero browser dependencies.
 *  - Actor tier: click/type/state/screenshot inside a disposable browser,
 *    with live-view frames (StreamFrame) and human takeover (ControlCommand)
 *    per the protocol. The engine is injected — Playwright in the sandbox
 *    worker, a fake in tests — so the model-facing surface stays stable.
 */

import type {
  CapabilitySnapshot,
  Card,
  CommandSpec,
  InvokeCommand,
  CommandResult,
  Args,
  ControlCommand,
  StreamFrame,
} from '../types.js';
import type { Runtime } from '../registry.js';
import {
  DDG_ENDPOINT,
  extractDdgResults,
  resolveSearch,
  type SearchHit,
  type SearchProvider,
} from '../search.js';

const SPECS: CommandSpec[] = [
  {
    id: 'web.navigate',
    version: 'v1',
    title: 'Open a URL and read the page',
    description: 'Fetches a URL (http/https only) and returns readable text, title and links.',
    args: [{ name: 'url', type: 'string', description: 'URL to open', required: true }],
    defaultApproval: 'AUTO',
  },
  {
    id: 'web.click',
    version: 'v1',
    title: 'Click an element in the sandboxed browser',
    description: 'Clicks an element by index from the last web.state (preferred) or a CSS selector. Needs a connected sandbox browser worker.',
    args: [
      { name: 'elementIndex', type: 'number', description: 'Element index from the last state', required: false },
      { name: 'selector', type: 'string', description: 'CSS selector alternative', required: false },
    ],
    defaultApproval: 'ASK_ONCE',
  },
  {
    id: 'web.type',
    version: 'v1',
    title: 'Type into the sandboxed browser',
    description: 'Types text into a field (by element index from web.state or CSS selector) in the sandboxed browser. Needs a connected sandbox browser worker.',
    args: [
      { name: 'elementIndex', type: 'number', description: 'Target field', required: false },
      { name: 'selector', type: 'string', description: 'CSS selector alternative', required: false },
      { name: 'text', type: 'string', description: 'Text to type', required: true },
    ],
    defaultApproval: 'ASK_ALWAYS',
  },
  {
    id: 'web.state',
    version: 'v1',
    title: 'Get page state as an accessibility tree',
    description: 'Returns the current page as indexed, interactive elements (Dots pattern) from the sandboxed browser. Needs a connected sandbox browser worker.',
    args: [],
    defaultApproval: 'AUTO',
  },
  {
    id: 'web.search',
    version: 'v1',
    title: 'Search the web',
    description: 'Runs a web search and returns top results with titles, urls and snippets.',
    args: [{ name: 'query', type: 'string', description: 'Search query', required: true }],
    defaultApproval: 'AUTO',
  },
];

/** One indexed interactive element of the live page. */
export interface PageElement {
  index: number;
  role: string; // "link" | "button" | "textbox" | ...
  name: string;
  selector?: string; // best-effort CSS path for the engine
}

export interface PageState {
  url: string;
  title: string;
  elements: PageElement[];
}

/**
 * The sandbox browser engine contract. Implemented by the Playwright worker
 * (apps/../sandbox) in production and by fakes in tests.
 */
export interface BrowserActor {
  /** Current indexed page state (url/title/elements). */
  state(): Promise<PageState>;
  click(target: { elementIndex?: number; selector?: string }): Promise<void>;
  type(target: { elementIndex?: number; selector?: string; text: string }): Promise<void>;
  /** PNG base64 of the current viewport — used for live-view frames. */
  screenshot(): Promise<string>;
  /** Optional takeover hooks: stop actuation while the human drives. */
  takeover?(): Promise<void>;
  release?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface BrowserSandboxEvents {
  /** Live-view frames — the Muse watch-the-agent-work channel. */
  onFrame?: (frame: StreamFrame) => void;
}

export interface BrowserSandboxOptions {
  runtimeId?: string;
  searchEndpoint?: string; // HTML endpoint; default DuckDuckGo lite
  /** KEY 2 · Brave Search API key. Empty → keyless DuckDuckGo. */
  searchApiKey?: string;
  /** 'auto' (default) uses Brave when a key exists. */
  searchProvider?: SearchProvider;
  fetchFn?: typeof fetch;   // injectable for tests
  maxBytes?: number;
  /** Observes search downgrades (e.g. Brave key expired → DuckDuckGo). */
  onSearchFallback?: (reason: string) => void;
  /** Actor-tier engine (instance or lazy factory). Omit = reader tier only. */
  actor?: BrowserActor | (() => Promise<BrowserActor>);
  events?: BrowserSandboxEvents;
}

export type { SearchHit } from '../search.js';

export class BrowserSandboxRuntime implements Runtime {
  readonly runtimeId: string;
  private searchEndpoint: string;
  private searchApiKey: string;
  private searchProvider: SearchProvider;
  private fetchFn: typeof fetch;
  private maxBytes: number;
  private actorOrFactory?: BrowserActor | (() => Promise<BrowserActor>);
  private actorInstance?: BrowserActor;
  private events: BrowserSandboxEvents;
  private onSearchFallback?: (reason: string) => void;
  /** Set while the human holds the wheel (ControlCommand "takeover"). */
  private humanInControl = false;
  /** Elements from the most recent web.state — elementIndex resolves here. */
  private lastState?: PageState;

  constructor(opts: BrowserSandboxOptions = {}) {
    this.runtimeId = opts.runtimeId ?? 'sandbox-browser';
    this.searchEndpoint = opts.searchEndpoint ?? DDG_ENDPOINT;
    this.searchApiKey = opts.searchApiKey ?? '';
    this.searchProvider = opts.searchProvider ?? 'auto';
    this.onSearchFallback = opts.onSearchFallback;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxBytes = opts.maxBytes ?? 300_000;
    this.actorOrFactory = opts.actor;
    this.events = opts.events ?? {};
  }

  async snapshot(): Promise<CapabilitySnapshot> {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'sandbox-browser',
      protocolVersion: '1',
      commands: SPECS,
      dataSources: [],
      triggers: [],
    };
  }

  async invoke(cmd: InvokeCommand): Promise<CommandResult> {
    try {
      switch (cmd.commandId) {
        case 'web.navigate': {
          const url = str(cmd.args.url) ?? '';
          const page = await this.navigate(url);
          return ok(cmd, page.title, page.text, { links: page.links.slice(0, 25) });
        }
        case 'web.search': {
          const query = str(cmd.args.query) ?? '';
          const hits = await this.search(query);
          const cards: Card[] = hits.map((h) => ({ kind: 'search', json: JSON.stringify(h) }));
          return ok(cmd, `search: ${query}`, hits.map((h) => `${h.title}\n${h.url}\n${h.snippet}`).join('\n\n'), undefined, cards);
        }
        case 'web.click':
          return await this.actorCommand(cmd, async (actor) => {
            const el = num(cmd.args.elementIndex);
            const sel = str(cmd.args.selector);
            await actor.click({ elementIndex: el, selector: sel });
            const label = el !== undefined ? `element [${el}]` : `selector "${sel}"`;
            const state = await actor.state();
            this.lastState = state;
            return `clicked ${label} — now on "${state.title}" (${state.url})`;
          });
        case 'web.type':
          return await this.actorCommand(cmd, async (actor) => {
            const text = str(cmd.args.text) ?? '';
            await actor.type({ elementIndex: num(cmd.args.elementIndex), selector: str(cmd.args.selector), text });
            return `typed ${text.length} chars`;
          });
        case 'web.state':
          return await this.actorCommand(cmd, async (actor) => {
            const state = await actor.state();
            this.lastState = state;
            const lines = state.elements.map((e) => `[${e.index}] ${e.role} "${e.name}"`);
            return `${state.title} — ${state.url}\n${state.elements.length} elements:\n${lines.join('\n')}`;
          });
        default:
          throw new Error(`unknown web command: ${cmd.commandId}`);
      }
    } catch (err) {
      return {
        invocationId: cmd.invocationId,
        ok: false,
        error: { code: 500, message: (err as Error).message, retryable: true },
      };
    }
  }

  /**
   * Human live control (Muse AgentBrowserTakeoverControls): "takeover" blocks
   * agent actuation until "release"; "cancel" asks the worker to abort.
   */
  async control(cmd: ControlCommand): Promise<void> {
    if (cmd.action === 'takeover') {
      this.humanInControl = true;
      await this.actorInstance?.takeover?.();
    } else if (cmd.action === 'release') {
      this.humanInControl = false;
      await this.actorInstance?.release?.();
    } else if (cmd.action === 'cancel') {
      await this.actorInstance?.dispose?.();
      this.actorInstance = undefined;
      this.humanInControl = false;
    }
  }

  state(): PageState | undefined {
    return this.lastState;
  }

  private async getActor(): Promise<BrowserActor | undefined> {
    if (this.actorInstance) return this.actorInstance;
    if (!this.actorOrFactory) return undefined;
    this.actorInstance =
      typeof this.actorOrFactory === 'function' ? await this.actorOrFactory() : this.actorOrFactory;
    return this.actorInstance;
  }

  /** Shared gate for actor-tier commands: engine present + human not driving. */
  private async actorCommand(
    cmd: InvokeCommand,
    run: (actor: BrowserActor) => Promise<string>,
  ): Promise<CommandResult> {
    if (this.humanInControl) {
      return {
        invocationId: cmd.invocationId,
        ok: false,
        error: {
          code: 409,
          message: 'the user has taken control of the sandbox browser; wait until they release it',
          retryable: true,
        },
      };
    }
    const actor = await this.getActor();
    if (!actor) {
      return {
        invocationId: cmd.invocationId,
        ok: false,
        error: {
          code: 501,
          message: `${cmd.commandId} needs a sandbox browser worker connected (see sandbox/ worker)`,
          retryable: false,
        },
      };
    }
    const summary = await run(actor);
    // Live view: every actuation is followed by a viewport frame.
    if (this.events.onFrame && actor.screenshot) {
      try {
        const frame = await actor.screenshot();
        this.events.onFrame({ kind: 'viewport', data: frame, atMs: Date.now() });
      } catch {
        /* frame loss is non-fatal */
      }
    }
    return ok(cmd, summary, summary);
  }

  static specs(): CommandSpec[] {
    return SPECS;
  }

  /* ---------------- fetch + extraction (reader tier) ---------------- */

  private async navigate(rawUrl: string): Promise<{ title: string; text: string; links: string[] }> {
    const url = normalizeUrl(rawUrl);
    const html = await this.get(url);
    return extractPage(html, url);
  }

  /** Swapped live when the user saves key #2 in the panel/CLI. */
  setSearch(opts: { apiKey?: string; provider?: SearchProvider }): void {
    if (opts.apiKey !== undefined) this.searchApiKey = opts.apiKey;
    if (opts.provider !== undefined) this.searchProvider = opts.provider;
  }

  /** Which engine the next web.search will use. */
  searchMode(): 'brave' | 'duckduckgo' {
    const wantBrave = this.searchProvider === 'brave' || (this.searchProvider === 'auto' && this.searchApiKey.length > 0);
    return wantBrave && this.searchApiKey.length > 0 ? 'brave' : 'duckduckgo';
  }

  async search(query: string): Promise<SearchHit[]> {
    return resolveSearch(query, {
      provider: this.searchProvider,
      apiKey: this.searchApiKey,
      fetchFn: this.fetchFn,
      fallback: async (q) => {
        const html = await this.get(this.searchEndpoint + encodeURIComponent(q));
        return extractDdgResults(html);
      },
      onFallback: (reason) => this.onSearchFallback?.(reason),
    });
  }

  private async get(url: string): Promise<string> {
    const res = await this.fetchFn(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; openclicky/0.1; +https://github.com/ranaalyan1/openclicky)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
    const text = await res.text();
    if (text.length > this.maxBytes) return text.slice(0, this.maxBytes);
    return text;
  }
}

function ok(cmd: InvokeCommand, title: string, body: string, extra?: Record<string, unknown>, cards?: Card[]): CommandResult {
  const limit = 6000;
  return {
    invocationId: cmd.invocationId,
    ok: true,
    data: {
      kind: 'string',
      value: JSON.stringify({ title, body: body.slice(0, limit), ...(extra ?? {}) }),
    },
    ...(cards && cards.length > 0 ? { cards } : {}),
  };
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = new URL('https://' + trimmed);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https URLs are allowed');
  }
  return parsed.toString();
}

/* ---------------- HTML → text (no deps) ---------------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPage(html: string, url: string): { title: string; text: string; links: string[] } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? url);
  const main = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = stripTags(main);
  const links: string[] = [];
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    try {
      links.push(new URL(decodeEntities(m[1]), url).toString());
    } catch {
      /* skip malformed hrefs */
    }
  }
  return { title, text, links };
}

function str(v: Args[string] | undefined): string | undefined {
  return v?.kind === 'string' ? v.value : undefined;
}

function num(v: Args[string] | undefined): number | undefined {
  return v?.kind === 'number' ? v.value : undefined;
}
