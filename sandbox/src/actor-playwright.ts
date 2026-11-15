/**
 * PlaywrightActor — the real BrowserActor for the sandbox worker.
 *
 * Runs Chromium inside the disposable worker (container, per task), never on
 * the host. Playwright is loaded dynamically so this package still builds
 * where browsers/deps aren't installed yet; a missing install fails loudly
 * with the fix command.
 *
 * Takeover: in headful mode (OPENCLICKY_SANDBOX_HEADFUL=1, intended to run
 * under a container with a streamed display) the human simply grabs the
 * mouse; headless takeover is signaled only (the stream UI is a milestone).
 */

import type { BrowserActor, PageElement, PageState } from '@openclicky/core';

/** Loose structural types so this package compiles without playwright types. */
type PWPage = {
  goto(url: string, opts?: unknown): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(opts: { type: 'png' }): Promise<Buffer>;
  close(): Promise<void>;
};
type PWBrowser = { newPage(): Promise<PWPage>; close(): Promise<void> };
type PWChromium = { launch(opts: { headless: boolean }): Promise<PWBrowser> };

async function loadChromium(): Promise<PWChromium> {
  const moduleName = 'playwright'; // dynamic specifier: not compile-time checked
  try {
    const pw = (await import(moduleName)) as { chromium: PWChromium };
    return pw.chromium;
  } catch {
    throw new Error(
      'playwright is not installed in this worker — run `npm i && npx playwright install chromium` (or use the sandbox container image)',
    );
  }
}

export interface PlaywrightActorOptions {
  headful?: boolean;
  startUrl?: string;
}

export class PlaywrightActor implements BrowserActor {
  private browser?: PWBrowser;
  private page?: PWPage;
  private headful: boolean;
  private startUrl: string;
  private lastElements: PageElement[] = [];

  constructor(opts: PlaywrightActorOptions = {}) {
    this.headful = opts.headful ?? process.env.OPENCLICKY_SANDBOX_HEADFUL === '1';
    this.startUrl = opts.startUrl ?? 'about:blank';
  }

  async launch(): Promise<void> {
    if (this.page) return;
    const chromium = await loadChromium();
    this.browser = await chromium.launch({ headless: !this.headful });
    this.page = await this.browser.newPage();
    await this.page.goto(this.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }

  async state(): Promise<PageState> {
    const page = await this.requirePage();
    const raw = (await page.evaluate(INDEX_ELEMENTS_JS)) as {
      elements: { role: string; name: string; selector: string }[];
    };
    this.lastElements = raw.elements.map((e, i) => ({ index: i, role: e.role, name: e.name, selector: e.selector }));
    return { url: page.url(), title: await page.title(), elements: this.lastElements };
  }

  async click(target: { elementIndex?: number; selector?: string }): Promise<void> {
    const page = await this.requirePage();
    await page.click(this.resolveSelector(target));
    await page.evaluate('new Promise(r => setTimeout(r, 150))').catch(() => undefined);
  }

  async type(target: { elementIndex?: number; selector?: string; text: string }): Promise<void> {
    const page = await this.requirePage();
    await page.fill(this.resolveSelector(target), target.text);
  }

  async screenshot(): Promise<string> {
    const page = await this.requirePage();
    const buf = await page.screenshot({ type: 'png' });
    return buf.toString('base64');
  }

  async takeover(): Promise<void> {
    // In headful mode the user just uses the window. Headless takeover needs
    // the streamed display — a milestone; flagging is still useful for UIs.
    if (!this.headful) {
      // no-op signal point; kept so the runtime's control() is honored
    }
  }

  async release(): Promise<void> {
    /* symmetric no-op */
  }

  async dispose(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
  }

  private resolveSelector(target: { elementIndex?: number; selector?: string }): string {
    if (target.selector) return target.selector;
    if (target.elementIndex !== undefined) {
      const el = this.lastElements[target.elementIndex];
      if (!el?.selector) {
        throw new Error(`elementIndex ${target.elementIndex} unknown — call web.state first to refresh the element list`);
      }
      return el.selector;
    }
    throw new Error('click/type need an elementIndex (from web.state) or a CSS selector');
  }

  private async requirePage(): Promise<PWPage> {
    await this.launch();
    if (!this.page) throw new Error('browser page unavailable');
    return this.page;
  }
}

/**
 * In-page script: index the visible, interactive elements and give each a
 * stable-enough CSS path. Runs inside the sandbox page context.
 */
const INDEX_ELEMENTS_JS = `(() => {
  const els = [];
  const seen = new Set();
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    for (let i = 0; i < 3 && cur && cur !== document.body; i++) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) break;
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') return ['checkbox','radio'].includes(el.type) ? el.type : 'textbox';
    return t;
  };
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.name || '')
      .toString().replace(/\\s+/g, ' ').trim().slice(0, 120);
  const candidates = document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[role=textbox],[contenteditable="true"],summary');
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const key = roleOf(el) + '|' + nameOf(el) + '|' + Math.round(rect.x) + ',' + Math.round(rect.y);
    if (seen.has(key)) continue;
    seen.add(key);
    els.push({ role: roleOf(el), name: nameOf(el), selector: sel(el) });
    if (els.length >= 250) break;
  }
  return { elements: els };
})()`;
