import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { AppConfig } from '../../config/config.schema.js';

/** One AI request: a fixed instruction, the (already redacted) input, and the JSON shape to read back. */
export type AiTask<T extends z.ZodType> = { system: string; input: string; schema: T };

export interface AiProvider {
  readonly name: 'claude' | 'gemini';
  json<T extends z.ZodType>(task: AiTask<T>): Promise<z.output<T>>;
}

export class AiUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AiUnavailable';
  }
}

const CLAUDE_MODEL = 'claude-opus-5-5';
const GEMINI_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 60_000;

/** Claude reads statements and categorizes (TECH-SPEC decision 10), through the official SDK with structured output. */
export class ClaudeProvider implements AiProvider {
  readonly name = 'claude' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  }

  async json<T extends z.ZodType>(task: AiTask<T>): Promise<z.output<T>> {
    const res = await this.client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: task.system,
      messages: [{ role: 'user', content: task.input }],
      // Reading rows and picking a category are routine; low effort keeps them fast and cheap.
      output_config: { effort: 'low', format: zodOutputFormat(task.schema) },
    });
    if (res.stop_reason === 'refusal') throw new AiUnavailable('refused');
    if (res.stop_reason === 'max_tokens') throw new AiUnavailable('too_long');
    if (res.parsed_output == null) throw new AiUnavailable('unreadable');
    return res.parsed_output as z.output<T>;
  }
}

/** Gemini, the fallback when Claude fails or is slow (TECH-SPEC decision 10). */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async json<T extends z.ZodType>(task: AiTask<T>): Promise<z.output<T>> {
    const res = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: task.system }] },
          contents: [{ role: 'user', parts: [{ text: task.input }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(task.schema) },
        }),
      },
    );
    if (!res.ok) throw new AiUnavailable(`gemini_${res.status}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new AiUnavailable('unreadable');
    return task.schema.parse(JSON.parse(text));
  }
}

/**
 * Claude first, Gemini after an error, a timeout or a refusal. Gemini's free tier may train on what it's sent,
 * so in production it's used only once GOOGLE_GEMINI_PAID_PLAN confirms a paid plan (TECH-SPEC 5.8).
 */
export function providersFor(config: AppConfig): AiProvider[] {
  const out: AiProvider[] = [];
  if (config.anthropicApiKey) out.push(new ClaudeProvider(config.anthropicApiKey));
  const geminiAllowed = config.appEnv !== 'production' || config.geminiPaidPlan;
  if (config.geminiApiKey && geminiAllowed) out.push(new GeminiProvider(config.geminiApiKey));
  return out;
}
