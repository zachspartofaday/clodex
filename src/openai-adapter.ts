import { tool, jsonSchema, streamText, generateText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { parseToolArguments } from './proxy-shared.js';
import type { SdkCallParams } from './sdk-adapter.js';
import {
  SDK_NON_STREAMING_TIMEOUT_MS,
  SDK_STREAM_IDLE_TIMEOUT_MS,
  SdkTimeoutError,
  oauthServiceTier,
  reportUnsupportedServiceTier,
  streamAbortError,
} from './sdk-adapter.js';
import { upstreamMaxRetries } from './upstream-retry.js';

// ── OpenAI request shapes ───────────────────────────────────────────────────

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | Array<any>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAiRequest {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

// ── Translation: OpenAI Request → SDK Call Params ───────────────────────────

export function translateOpenAiRequest(
  body: OpenAiRequest,
  options?: {
    /** ChatGPT Codex OAuth requires instructions in providerOptions and manages its own output limit. */
    openAiOAuth?: boolean;
  },
): SdkCallParams {
  // Pre-scan to map tool_call_id → function name so tool result messages can reference it.
  const toolNameById = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }

  let system: string | undefined;
  const messages: ModelMessage[] = [];

  for (const msg of body.messages) {
    switch (msg.role) {
      case 'system':
        system = typeof msg.content === 'string' ? msg.content : undefined;
        break;

      case 'user':
        messages.push({ role: 'user', content: msg.content as any } as ModelMessage);
        break;

      case 'assistant': {
        const parts: any[] = [];
        if (typeof msg.content === 'string' && msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls ?? []) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: parseToolArguments(tc.function.arguments),
          });
        }
        messages.push({ role: 'assistant', content: parts.length > 0 ? parts : '' } as ModelMessage);
        break;
      }

      case 'tool': {
        const resultPart = {
          type: 'tool-result',
          toolCallId: msg.tool_call_id ?? '',
          toolName: toolNameById.get(msg.tool_call_id ?? '') ?? 'unknown',
          output: {
            type: 'text',
            value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
          },
        };
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'tool' && Array.isArray(lastMsg.content)) {
          lastMsg.content.push(resultPart as any);
        } else {
          messages.push({ role: 'tool', content: [resultPart] } as unknown as ModelMessage);
        }
        break;
      }
    }
  }

  let sdkToolChoice: SdkCallParams['toolChoice'];
  if (body.tool_choice === 'auto' || body.tool_choice === 'required') {
    sdkToolChoice = body.tool_choice;
  } else if (typeof body.tool_choice === 'object' && body.tool_choice?.type === 'function') {
    sdkToolChoice = { type: 'tool', toolName: body.tool_choice.function.name };
  }

  let tools: SdkCallParams['tools'];
  if (body.tools?.length) {
    tools = {} as any;
    for (const t of body.tools) {
      if (t.type === 'function' && t.function.name) {
        const schema = t.function.parameters ? jsonSchema(t.function.parameters) : undefined;
        (tools as any)[t.function.name] = tool({
          description: t.function.description ?? '',
          inputSchema: (schema ?? jsonSchema({ type: 'object', properties: {} })) as any,
        });
      }
    }
  }

  if (options?.openAiOAuth) {
    // Mirror the OAuth shaping in sdk-adapter's translateRequest: the ChatGPT
    // Codex OAuth backend rejects the standard system/instructions field (it
    // requires providerOptions.openai.instructions), manages its own output
    // limit (an explicit max_output_tokens yields an empty finish:'other'
    // response), and expects store:false.
    const instructions = system?.trim() || 'You are a coding assistant.';
    const serviceTier = oauthServiceTier();
    return {
      messages,
      tools,
      toolChoice: sdkToolChoice,
      temperature: body.temperature,
      providerOptions: {
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          instructions,
          ...(serviceTier ? { serviceTier } : {}),
        },
      },
    };
  }

  return {
    instructions: system,
    messages,
    tools,
    toolChoice: sdkToolChoice,
    temperature: body.temperature,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
  };
}

// ── Translation: SDK Response → OpenAI JSON / SSE ───────────────────────────

function requireOpenAiTerminalFinish(
  part: { finishReason?: unknown; rawFinishReason?: unknown } | undefined,
): string {
  if (
    typeof part?.finishReason !== 'string'
    || (part.finishReason === 'other' && part.rawFinishReason === undefined)
  ) {
    throw new Error('Upstream OpenAI stream ended without a terminal event');
  }
  return part.finishReason;
}

/**
 * The Anthropic adapter's stream liveness policy, applied to the OpenAI routes.
 *
 * A no-event idle deadline that resets on every provider part, and NO fixed
 * total deadline: a long generation that is still producing output is healthy,
 * and cutting it at a wall-clock ceiling discards work the user already waited
 * for. The deadline aborts upstream work through a Relay-owned controller
 * rather than only abandoning the local read, and it surfaces as the shared
 * `SdkTimeoutError` so a timeout stays distinguishable from an upstream fault.
 *
 * Do not compose streamText's own timeout signals here — see the note in
 * `streamAnthropicResponse`; Relay owns these timers and settles its controller
 * after consumption.
 */
function openAiIdleWatchdog() {
  const controller = new AbortController();
  let lastPartAt = Date.now();
  let outputBegan = false;
  const timeoutError = () => new SdkTimeoutError(
    'idle_timeout',
    `no data received from provider for ${Math.round(SDK_STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
    Math.max(0, Date.now() - lastPartAt),
    SDK_STREAM_IDLE_TIMEOUT_MS,
    outputBegan,
  );
  const arm = () => setTimeout(() => controller.abort(timeoutError()), SDK_STREAM_IDLE_TIMEOUT_MS);
  let timer = arm();
  return {
    signal: controller.signal,
    /** Record that this request has already produced content for the client. */
    markOutput() { outputBegan = true; },
    /** Every provider event is liveness: restart the deadline. */
    beat() {
      clearTimeout(timer);
      lastPartAt = Date.now();
      timer = arm();
    },
    /**
     * Prefer the local deadline as the cause. An aborted stream ends without a
     * terminal event, so without this the caller would report the generic
     * missing-terminal failure and hide why the request died.
     */
    throwIfAborted() {
      if (controller.signal.aborted) throw streamAbortError(controller.signal);
    },
    /**
     * Stop the timer and settle the Relay-owned signal only after consumption,
     * so Node can release the AI SDK's listener graph.
     */
    settle() {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

export interface CollectedOpenAiStream {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: string | undefined;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
}

/** Reduce an SDK full stream into the fields a non-streaming chat completion needs. */
export async function collectOpenAiStream(stream: AsyncIterable<unknown>): Promise<CollectedOpenAiStream> {
  const collected: CollectedOpenAiStream = { text: '', toolCalls: [], finishReason: undefined, usage: undefined };
  let finishPart: { finishReason?: unknown; rawFinishReason?: unknown; totalUsage?: CollectedOpenAiStream['usage']; usage?: CollectedOpenAiStream['usage'] } | undefined;
  for await (const part of stream) {
    const p = part as any;
    switch (p.type) {
      case 'text-delta':
        collected.text += p.textDelta ?? p.text ?? '';
        break;
      case 'tool-call':
        collected.toolCalls.push({
          toolCallId: p.toolCallId ?? '',
          toolName: p.toolName ?? '',
          input: p.input,
        });
        break;
      case 'finish':
        finishPart = p;
        break;
      case 'error':
        throw p.error instanceof Error || (p.error && typeof p.error === 'object')
          ? p.error
          : new Error(typeof p.error === 'string' ? p.error : 'Upstream stream failed');
    }
  }
  collected.finishReason = requireOpenAiTerminalFinish(finishPart);
  collected.usage = finishPart?.totalUsage ?? finishPart?.usage;
  return collected;
}

export async function generateOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  options?: { forceStream?: boolean },
) {
  let result: { text: string; toolCalls?: CollectedOpenAiStream['toolCalls']; finishReason?: string; usage?: CollectedOpenAiStream['usage']; warnings?: unknown };
  if (options?.forceStream) {
    // Some upstreams (e.g. ChatGPT's Codex OAuth backend) only ever answer as a
    // stream. Request a real stream from the SDK and collect it into one
    // response instead of issuing a non-streaming request upstream.
    const watchdog = openAiIdleWatchdog();
    const { stream } = streamText({
      model,
      ...(params as any),
      maxRetries: upstreamMaxRetries(),
      abortSignal: watchdog.signal,
      onError: () => {},
      onStepFinish: step => reportUnsupportedServiceTier(params, step.warnings),
    });
    // forceStream is still a stream, so it keeps the idle deadline and no total
    // ceiling. Watching here rather than inside collectOpenAiStream leaves that
    // reducer's contract — and its callers — unchanged.
    const watched = (async function* () {
      for await (const part of stream as AsyncIterable<unknown>) {
        watchdog.beat();
        const p = part as any;
        if (p?.type === 'tool-call' || (p?.type === 'text-delta' && (p.textDelta ?? p.text ?? ''))) {
          watchdog.markOutput();
        }
        yield part;
      }
    })();
    try {
      result = await collectOpenAiStream(watched);
      // An aborted request never returns a response, even if the reducer
      // happened to see a terminal event as the deadline fired.
      watchdog.throwIfAborted();
    } catch (err) {
      watchdog.throwIfAborted();
      throw err;
    } finally {
      watchdog.settle();
    }
  } else {
    // No output flows on this path, so a stalled call is indistinguishable from
    // a slow one: it carries the absolute ceiling instead of idle detection.
    const totalAbort = new AbortController();
    const startedAt = Date.now();
    const totalTimer = setTimeout(
      () => totalAbort.abort(new SdkTimeoutError(
        'total_timeout',
        `provider request exceeded ${Math.round(SDK_NON_STREAMING_TIMEOUT_MS / 1000)}s`,
        Math.max(0, Date.now() - startedAt),
        SDK_NON_STREAMING_TIMEOUT_MS,
        false,
      )),
      SDK_NON_STREAMING_TIMEOUT_MS,
    );
    try {
      result = (await generateText({
        model,
        ...(params as any),
        maxRetries: upstreamMaxRetries(),
        abortSignal: totalAbort.signal,
      })) as any;
    } finally {
      clearTimeout(totalTimer);
      if (!totalAbort.signal.aborted) totalAbort.abort();
    }
  }
  reportUnsupportedServiceTier(params, result.warnings);
  const message: Record<string, any> = { role: 'assistant', content: result.text || null };

  if (result.toolCalls?.length) {
    message.tool_calls = result.toolCalls.map((tc: any) => ({
      id: tc.toolCallId,
      type: 'function',
      function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
    }));
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: responseModelId,
    choices: [{ index: 0, message, finish_reason: result.finishReason || 'stop' }],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
      total_tokens: result.usage?.totalTokens ?? 0,
    },
  };
}

export async function streamOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const watchdog = openAiIdleWatchdog();
  const { stream } = streamText({
    model,
    ...(params as any),
    maxRetries: upstreamMaxRetries(),
    abortSignal: watchdog.signal,
    onStepFinish: step => reportUnsupportedServiceTier(params, step.warnings),
  });
  const baseData = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: responseModelId,
  };

  const send = (delta: Record<string, any>, finish_reason: string | null = null) => {
    watchdog.markOutput();
    onChunk(`data: ${JSON.stringify({ ...baseData, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  };
  let finishPart: { finishReason?: unknown; rawFinishReason?: unknown } | undefined;

  try {
    for await (const part of stream) {
      watchdog.beat();
      const p = part as any;
      switch (p.type) {
        case 'text-delta':
          send({ role: 'assistant', content: p.textDelta ?? p.text ?? '' });
          break;
        case 'tool-input-start':
          send({ role: 'assistant', tool_calls: [{ index: 0, id: p.id ?? p.toolCallId, type: 'function', function: { name: p.toolName, arguments: '' } }] });
          break;
        case 'tool-input-delta':
          send({ tool_calls: [{ index: 0, function: { arguments: p.delta ?? p.text ?? p.argsTextDelta ?? '' } }] });
          break;
        case 'finish':
          finishPart = p;
          break;
        case 'error':
          throw p.error instanceof Error || (p.error && typeof p.error === 'object')
            ? p.error
            : new Error(typeof p.error === 'string' ? p.error : 'Upstream stream failed');
      }
    }

    // Before the terminal check: an idle abort ends the stream without a finish
    // part, and reporting that as a missing terminal event would hide the real
    // cause. Either way no completion frame and no [DONE] is emitted.
    watchdog.throwIfAborted();
    send({}, requireOpenAiTerminalFinish(finishPart));
    onChunk('data: [DONE]\n\n');
  } catch (err) {
    watchdog.throwIfAborted();
    throw err;
  } finally {
    watchdog.settle();
  }
}
