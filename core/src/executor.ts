/**
 * Executor — the agent loop. Chat in, tool calls out, HITL gates in front
 * of anything sensitive, results back to the model until done.
 *
 * Arguments are validated against the CommandSpec (required / type / enum)
 * before anything runs — violations are reported to the model as errors so
 * it can correct itself, never guessed. Image results (screenshots) are
 * attached to the conversation as vision content parts so a multimodal
 * model actually sees the screen; pass `vision: false` for text-only
 * endpoints (surfaces expose this as OPENCLICKY_VISION=0).
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  Args,
  ArgValue,
  CommandSpec,
  InvokeCommand,
  TriggerEvent,
} from './types.js';
import type { ChatMessage, ModelAdapter, ToolCallRequest } from './model.js';
import type { RuntimeRegistry } from './registry.js';
import type { HitlEngine } from './hitl.js';

export interface ExecutorEvents {
  onApprovalRequest?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onAssistantMessage?: (content: string) => void;
  onCommandResult?: (ok: boolean, summary: string) => void;
}

interface ToolOutcome {
  /** JSON string fed back to the model as the tool message. */
  toolText: string;
  /** PNG base64 to attach as a following user-role image part. */
  imageBase64?: string;
}

export class Executor {
  constructor(
    private model: ModelAdapter,
    private registry: RuntimeRegistry,
    private hitl: HitlEngine,
    private events: ExecutorEvents,
    private vision: boolean = true,
  ) {}

  /**
   * Run a user turn to completion: model <-> tools until the model answers
   * without tool calls. Sensitive commands pause for human approval.
   */
  async run(history: ChatMessage[], maxSteps = 12): Promise<ChatMessage[]> {
    const messages = [...history];
    for (let step = 0; step < maxSteps; step++) {
      const reply = await this.model.chat(messages, this.registry.toolSchemas());

      if (reply.content && this.events.onAssistantMessage) {
        this.events.onAssistantMessage(reply.content);
      }

      if (reply.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: reply.content });
        return messages;
      }

      messages.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls });

      // Dispatch first, append afterwards: tool result messages must follow
      // the assistant tool_calls message directly (provider requirement),
      // so vision payloads go in *after* all tool messages as user parts.
      const outcomes: { call: ToolCallRequest; outcome: ToolOutcome }[] = [];
      for (const call of reply.toolCalls) {
        outcomes.push({ call, outcome: await this.dispatchTool(call.name, call.argumentsJson) });
      }
      for (const { call, outcome } of outcomes) {
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.toolText });
      }
      if (this.vision) {
        for (const { call, outcome } of outcomes) {
          if (outcome.imageBase64) {
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Image returned by ${call.name}. Inspect it visually before choosing coordinates or next actions.`,
                },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${outcome.imageBase64}` } },
              ],
            });
          }
        }
      }
    }
    messages.push({
      role: 'assistant',
      content: 'I hit my step limit for this turn; some steps may be incomplete.',
    });
    return messages;
  }

  private async dispatchTool(commandId: string, argsJson: string): Promise<ToolOutcome> {
    const entry = this.registry.get(commandId);
    if (!entry) {
      return { toolText: fail(`unknown command: ${commandId}`) };
    }

    let args: Args;
    try {
      const raw = JSON.parse(argsJson || '{}') as Record<string, unknown>;
      const checked = validateArgs(entry.spec, raw);
      if (!checked.ok) {
        return { toolText: fail(`invalid arguments: ${checked.error}`) };
      }
      args = checked.args;
    } catch {
      return { toolText: fail('arguments were not valid JSON') };
    }

    const invocation: InvokeCommand = {
      invocationId: crypto.randomUUID(),
      commandId: commandId,
      commandVersion: entry.spec.version,
      args,
    };

    // HITL gate — Muse-style approval before sensitive execution.
    const verdict = this.hitl.gate(entry.spec, invocation.invocationId, args);
    if (verdict.action === 'refuse') {
      return { toolText: fail(`refused: ${verdict.reason}`) };
    }
    if (verdict.action === 'ask') {
      if (!this.events.onApprovalRequest) {
        return { toolText: fail('approval required but no approver connected') };
      }
      const decision = await this.events.onApprovalRequest(verdict.request);
      this.hitl.record(commandId, decision);
      if (!decision.approved) {
        return { toolText: fail('the user declined this action') };
      }
      invocation.approvedBy = decision.decidedBy;
    } else {
      invocation.approvedBy = verdict.approvedBy;
    }

    const result = await entry.runtime.invoke(invocation);
    this.events.onCommandResult?.(result.ok, result.ok ? brief(result.data) : result.error?.message ?? 'failed');
    if (!result.ok) {
      return { toolText: fail(result.error?.message ?? 'command failed') };
    }
    if (result.data?.kind === 'image') {
      const size = result.data.value.length;
      const note = this.vision
        ? `image attached to the conversation as a following message (${size} base64 chars)`
        : `image captured but not shown to the model (${size} base64 chars; vision disabled)`;
      return { toolText: JSON.stringify({ result: note, cards: result.cards ?? [] }), imageBase64: result.data.value };
    }
    return { toolText: JSON.stringify({ result: plain(result.data), cards: result.cards ?? [] }) };
  }

  /** Handle a proactive trigger: hand it to the model as a new turn. */
  async handleTrigger(event: TriggerEvent, systemPrompt: string): Promise<void> {
    // Triggered turns are a follow-up: build a fresh history with the event.
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `A device event fired: ${event.triggerId}. Payload: ${JSON.stringify(event.payload)}` },
    ];
    await this.run(messages);
  }
}

/**
 * Validate raw model arguments against the CommandSpec and coerce them into
 * typed ArgValues. Missing required args, bad coercions and out-of-enum
 * values are rejected with precise messages — the model fixes and retries.
 */
function validateArgs(
  spec: CommandSpec,
  raw: Record<string, unknown>,
): { ok: true; args: Args } | { ok: false; error: string } {
  const out: Args = {};
  for (const arg of spec.args) {
    const v = raw[arg.name];
    if (v === undefined || v === null) {
      if (arg.required) return { ok: false, error: `missing required argument "${arg.name}"` };
      continue;
    }
    switch (arg.type) {
      case 'number': {
        if (typeof v === 'boolean') return { ok: false, error: `argument "${arg.name}" must be a number` };
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isNaN(n)) return { ok: false, error: `argument "${arg.name}" must be a number` };
        out[arg.name] = { kind: 'number', value: n };
        break;
      }
      case 'boolean': {
        if (typeof v === 'boolean') out[arg.name] = { kind: 'boolean', value: v };
        else if (v === 'true' || v === 'false') out[arg.name] = { kind: 'boolean', value: v === 'true' };
        else return { ok: false, error: `argument "${arg.name}" must be a boolean` };
        break;
      }
      case 'enum': {
        const s = String(v);
        if (arg.enumValues && !arg.enumValues.includes(s)) {
          return { ok: false, error: `argument "${arg.name}" must be one of: ${arg.enumValues.join(', ')}` };
        }
        out[arg.name] = { kind: 'string', value: s };
        break;
      }
      case 'image': {
        out[arg.name] = { kind: 'image', value: String(v) };
        break;
      }
      default: {
        out[arg.name] = { kind: 'string', value: String(v) };
      }
    }
  }
  return { ok: true, args: out };
}

function fail(message: string): string {
  return JSON.stringify({ error: message });
}

function plain(v: ArgValue | undefined): unknown {
  return v && v.kind !== 'image' ? v.value : v ? `<image ${v.value.length}b>` : null;
}

function brief(v: ArgValue | undefined): string {
  if (!v) return 'ok';
  if (v.kind === 'image') return `image (${v.value.length} base64 chars)`;
  return String(v.value).slice(0, 120);
}
