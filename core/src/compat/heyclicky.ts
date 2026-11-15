/**
 * HeyClicky compatibility layer.
 *
 * OpenClicky is a clean-room implementation: none of HeyClicky's code is copied
 * (theirs is proprietary Windows C#/WinUI; ours is MIT TypeScript). What this
 * module *does* copy is the surface a HeyClicky-style model or client expects,
 * transcribed from the de-linked study copy:
 *
 *   - the underscore tool names its model sees (`browser`, `mac_step`, ...)
 *   - the `action`-keyed argument shapes those tools take
 *   - the single-step, wait-then-report, never-repeat-after-timeout semantics
 *
 * Mapping table below is the single source of truth: `docs/HEYCLICKY-COMPAT.md`
 * is generated from `HEYCLICKY_SURFACE`, so the doc can never drift from the
 * code. Anything HeyClicky does that OpenClicky cannot do yet is listed as
 * `absent` and answers with an explicit, actionable error instead of pretending.
 */

import type { Args, CommandResult, InvokeCommand } from '../types.js';
import type { ModelToolSchema } from '../model.js';
import type { RuntimeRegistry } from '../registry.js';

export type CompatStatus = 'implemented' | 'degraded' | 'absent';

export interface ActionMapping {
  /** HeyClicky action or sub-tool name. */
  action: string;
  /** OpenClicky command that answers it (empty when absent). */
  command: string;
  status: CompatStatus;
  note?: string;
}

export interface ToolMapping {
  /** Tool name as HeyClicky's model sees it. */
  tool: string;
  /** What the tool is for, in one line. */
  purpose: string;
  actions: ActionMapping[];
}

/**
 * The mapping table. `implemented` = same behaviour; `degraded` = same call
 * works with fewer results or different mechanics; `absent` = honest refusal
 * with the alternative spelled out.
 */
export const HEYCLICKY_SURFACE: ToolMapping[] = [
  {
    tool: 'browser',
    purpose: "the user's Chrome through the extension: tabs, DOM snapshots, page actions",
    actions: [
      { action: 'open {url}', command: 'web.navigate', status: 'implemented', note: 'fetches and returns title, text, links' },
      { action: 'extract {tabId}', command: 'web.navigate', status: 'degraded', note: 're-reads the page text without refs' },
      { action: 'snapshot {tabId}', command: 'web.state', status: 'implemented', note: 'indexed role: name [ref] lines' },
      { action: 'click {ref}', command: 'web.click', status: 'implemented', note: 'ref maps to elementIndex' },
      { action: 'fill {ref,text}', command: 'web.type', status: 'implemented' },
      { action: 'search {query}', command: 'web.search', status: 'implemented', note: 'Brave when key 2 is set, DuckDuckGo otherwise' },
      { action: 'tabs', command: '', status: 'absent', note: 'single-tab runtime; no tab group yet' },
      { action: 'batch {steps}', command: '', status: 'absent', note: 'chain single calls for now' },
      { action: 'javascript {code}', command: '', status: 'absent', note: 'needs the Playwright worker tier' },
      { action: 'press / scroll / wait_for / back', command: '', status: 'absent', note: 'coming with the actor tier' },
      { action: 'upload / download / dialog', command: '', status: 'absent' },
      { action: 'screenshot / click_at / hover_at / drag_at / type', command: '', status: 'absent', note: 'pixel tier lands with the sandbox worker' },
      { action: 'keep {tabId,why}', command: '', status: 'absent', note: 'nothing to keep in a single-tab runtime' },
    ],
  },
  {
    tool: 'mac_step',
    purpose: 'one PC step on the user\'s own screen, shown as a card and approved first',
    actions: [
      { action: 'inspect screen', command: 'pc.a11y_tree', status: 'degraded', note: 'returns the accessibility tree instead of performing a step' },
      { action: 'screenshot', command: 'pc.screenshot', status: 'implemented' },
      { action: 'click / type / keys / scroll', command: 'pc.click | pc.type_text | pc.press_key | pc.scroll', status: 'degraded', note: 'explicit commands instead of one outcome-driven step' },
      { action: 'launch app', command: 'pc.launch_app', status: 'implemented' },
      { action: 'single outcome-driven step with a card', command: '', status: 'absent', note: 'compose the pc.* commands above; HITL cards already gate them' },
    ],
  },
  {
    tool: 'sessions_spawn',
    purpose: 'hand background work to a helper task',
    actions: [
      { action: 'spawn', command: '', status: 'absent', note: 'no sub-session runtime yet; the executor handles the whole turn' },
      { action: 'send / status / interrupt / yield', command: '', status: 'absent' },
    ],
  },
  {
    tool: 'clicky_memory',
    purpose: 'the assistant\'s long-term notes about the user',
    actions: [
      { action: 'read / save', command: '', status: 'absent', note: 'memory lives in the host agent (Base44), not in the openclicky core' },
    ],
  },
  {
    tool: 'clicky_artifacts',
    purpose: 'files and documents the assistant produced',
    actions: [
      { action: 'list / open / reveal', command: 'pc.files.read', status: 'degraded', note: 'plain file reads only' },
    ],
  },
];

/** Tools worth advertising to a model today (hidden if every action is absent). */
export function heyclickyToolSchemas(): ModelToolSchema[] {
  const usable = HEYCLICKY_SURFACE.filter((t) => t.actions.some((a) => a.status !== 'absent'));
  return usable.map((t) => ({
    type: 'function',
    function: {
      name: t.tool,
      description:
        `${t.purpose}. Actions: ` +
        t.actions
          .filter((a) => a.status !== 'absent')
          .map((a) => `${a.action}${a.status === 'degraded' ? ' (degraded)' : ''}`)
          .join('; '),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: t.actions.filter((a) => a.status !== 'absent').map((a) => a.action.split(' ')[0].replace(/,$/, '')),
            description: 'Which action to run',
          },
          url: { type: 'string', description: 'browser open: target URL' },
          ref: { type: 'integer', description: 'browser snapshot: element ref / index' },
          selector: { type: 'string', description: 'CSS selector alternative to ref' },
          text: { type: 'string', description: 'browser fill / search query / typing text' },
          query: { type: 'string', description: 'browser search query' },
        },
        required: ['action'],
      },
    },
  }));
}

export interface CompatCallResult {
  ok: boolean;
  /** Text for the model. */
  text: string;
  commandId?: string;
  /** Present when the action is not in this build — the model should not retry. */
  unsupported?: true;
}

type Args2 = Record<string, unknown>;

function findAction(tool: string, action: string): ActionMapping | undefined {
  const mapping = HEYCLICKY_SURFACE.find((t) => t.tool === tool);
  if (!mapping) return undefined;
  const wanted = action.toLowerCase();
  return mapping.actions.find((a) => a.action.toLowerCase().split(/[\s{/]/)[0] === wanted);
}

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function n(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined;
}

/**
 * Accept both call shapes HeyClicky clients use:
 *   { action: 'open', url }              (flat)
 *   { open: { url } }                    (single-key, as its schema allows)
 */
export function normalizeCall(args: Args2): { action: string; params: Args2 } {
  const flat = s(args.action);
  if (flat) {
    const { action: _drop, ...params } = args;
    return { action: flat, params };
  }
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const only = keys[0];
    const value = args[only];
    return {
      action: only,
      params: value && typeof value === 'object' && !Array.isArray(value) ? (value as Args2) : {},
    };
  }
  return { action: keys[0] ?? '', params: args };
}

function toArgs(values: Record<string, string | number | undefined>): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'number' ? { kind: 'number', value: v } : { kind: 'string', value: v };
  }
  return out;
}

/**
 * Executes HeyClicky-shaped tool calls against whatever runtimes are
 * registered. It never invents capability: an action absent from the table is
 * refused with the alternative, so the model corrects itself instead of
 * retrying a phantom tool.
 */
export class HeyClickyCompat {
  constructor(private registry: RuntimeRegistry) {}

  /** Call one tool by its HeyClicky name. */
  async call(tool: string, args: Args2): Promise<CompatCallResult> {
    const { action, params } = normalizeCall(args ?? {});
    const mapping = findAction(tool, action);

    if (!mapping) {
      return {
        ok: false,
        unsupported: true,
        text: `Unknown ${tool} action "${action}". Available: ${this.available(tool).join(', ') || 'none'}.`,
      };
    }
    if (mapping.status === 'absent' || !mapping.command) {
      return {
        ok: false,
        unsupported: true,
        text:
          `${tool}/${action} is not in this build${mapping.note ? ` (${mapping.note})` : ''}. ` +
          `Do not retry it. Use instead: ${this.available(tool).join(', ') || 'the native pc.* / web.* commands'}.`,
      };
    }

    const commandId = mapping.command.split('|')[0].trim();
    const invocationId = `heyclicky-${tool}-${Date.now().toString(36)}`;

    const entry = this.registry.get(commandId);
    if (!entry) {
      return {
        ok: false,
        unsupported: true,
        text: `No connected runtime provides ${commandId}. Connect that device/runtime first; do not retry.`,
      };
    }

    const cmd: InvokeCommand = {
      invocationId,
      commandId,
      commandVersion: entry.spec.version,
      args: toArgs({
        url: s(params.url) ?? s(params.target),
        elementIndex: n(params.ref) ?? n(params.elementIndex),
        selector: s(params.selector),
        text: s(params.text),
        query: s(params.query) ?? s(params.text),
      }),
    };

    const result = await entry.runtime.invoke(cmd);
    return {
      ok: result.ok,
      commandId,
      text: result.ok ? this.describe(result) : `error: ${result.error?.message ?? 'unknown failure'}`,
    };
  }

  private describe(result: CommandResult): string {
    const data = result.data as { value?: unknown } | undefined;
    if (data && typeof data.value === 'string') {
      try {
        const parsed = JSON.parse(data.value) as { title?: string; body?: string };
        return parsed.body ? `${parsed.title ?? ''}\n\n${parsed.body}`.trim() : data.value;
      } catch {
        return data.value;
      }
    }
    return JSON.stringify(data ?? {});
  }

  private available(tool: string): string[] {
    const mapping = HEYCLICKY_SURFACE.find((t) => t.tool === tool);
    if (!mapping) return [];
    return mapping.actions.filter((a) => a.status !== 'absent').map((a) => a.action.split(/[\s{]/)[0]);
  }
}

/** Markdown for docs/HEYCLICKY-COMPAT.md — generated, never hand-maintained. */
export function renderCompatDoc(): string {
  const lines: string[] = [
    '# HeyClicky compatibility',
    '',
    'Generated from `core/src/compat/heyclicky.ts` (`HEYCLICKY_SURFACE`).',
    'OpenClicky copies the *surface* a HeyClicky model or client expects, never its code.',
    '',
  ];
  for (const tool of HEYCLICKY_SURFACE) {
    lines.push(`## \`${tool.tool}\``, '', `${tool.purpose}`, '');
    lines.push('| HeyClicky action | OpenClicky command | Status | Notes |', '|---|---|---|---|');
    for (const a of tool.actions) {
      lines.push(
        `| \`${a.action}\` | ${a.command ? `\`${a.command}\`` : '—'} | ${a.status} | ${a.note ?? ''} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
