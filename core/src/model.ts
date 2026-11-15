/**
 * Model adapter — talks to any OpenAI-compatible chat completions endpoint
 * (cloud or self-hosted; swap the base URL). OpenClicky stays model-agnostic:
 * the executor only sees messages + tool-call requests.
 */

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string }; // data: URL (base64) or remote URL
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text, or multimodal parts (e.g. a screenshot the model can see). */
  content: string | ContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCallRequest[];
}

/** Flatten message content to plain text (drops images). */
export function textContent(content: string | ContentPart[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export interface ToolCallRequest {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ModelToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

export interface ModelReply {
  content: string;
  toolCalls: ToolCallRequest[];
}

export interface ModelAdapter {
  chat(messages: ChatMessage[], tools: ModelToolSchema[]): Promise<ModelReply>;
}

export interface OpenAIAdapterOptions {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;
  temperature?: number;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(private opts: OpenAIAdapterOptions) {}

  /** Hot-swap config (in-app settings onboarding — no restart needed). */
  update(partial: Partial<OpenAIAdapterOptions>): void {
    this.opts = { ...this.opts, ...partial };
  }

  get config(): Readonly<OpenAIAdapterOptions> {
    return this.opts;
  }

  async chat(messages: ChatMessage[], tools: ModelToolSchema[]): Promise<ModelReply> {
    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: this.opts.temperature ?? 0.2,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`model call failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: {
        id: string; function: { name: string; arguments: string };
      }[] } }[];
    };
    const msg = data.choices[0]?.message;
    return {
      content: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      })),
    };
  }
}
