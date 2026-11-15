/**
 * Voice adapters — speech-to-text and text-to-speech against any
 * OpenAI-compatible audio endpoint (Whisper API, local whisper.cpp server,
 * LM Studio, ...). Same model-agnostic stance as the chat adapter.
 */

export interface VoiceAdapter {
  /** Transcribe raw audio bytes (webm/ogg/wav/mp3) to text. */
  transcribe(audio: Buffer, mime: string): Promise<string>;
  /** Synthesize speech; returns audio bytes (audio/mpeg by default). */
  speak(text: string): Promise<Buffer>;
}

export interface OpenAIVoiceOptions {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  sttModel?: string; // default "whisper-1"
  ttsModel?: string; // default "tts-1"
  voice?: string; // default "alloy"
  fetchFn?: typeof fetch; // injectable for tests
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};

export class OpenAIVoiceAdapter implements VoiceAdapter {
  private sttModel: string;
  private ttsModel: string;
  private voice: string;
  private fetchFn: typeof fetch;

  constructor(private opts: OpenAIVoiceOptions) {
    this.sttModel = opts.sttModel ?? 'whisper-1';
    this.ttsModel = opts.ttsModel ?? 'tts-1';
    this.voice = opts.voice ?? 'alloy';
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const ext = EXT_BY_MIME[mime] ?? 'webm';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext}`);
    form.append('model', this.sttModel);
    const res = await this.fetchFn(`${this.opts.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { text?: string };
    return data.text ?? '';
  }

  async speak(text: string): Promise<Buffer> {
    const res = await this.fetchFn(`${this.opts.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.ttsModel, voice: this.voice, input: text.slice(0, 4000) }),
    });
    if (!res.ok) throw new Error(`speech synthesis failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}
