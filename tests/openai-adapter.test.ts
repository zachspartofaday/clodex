import { describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { collectOpenAiStream, generateOpenAiResponse, streamOpenAiResponse, translateOpenAiRequest } from '../src/openai-adapter.js';
import { resetServiceTierWarningForTests, sdkTimeoutDetails } from '../src/sdk-adapter.js';
import { installParentNoticeSink } from '../src/parent-notice.js';

const finishReasonCases = [
  { label: 'stop', unified: 'stop', raw: 'native-stop', openAi: 'stop', accepted: true },
  { label: 'length', unified: 'length', raw: 'native-length', openAi: 'length', accepted: true },
  { label: 'content-filter', unified: 'content-filter', raw: 'native-filter', openAi: 'content_filter', accepted: true },
  { label: 'tool-calls', unified: 'tool-calls', raw: 'native-tools', openAi: 'tool_calls', accepted: true },
  { label: 'other with raw', unified: 'other', raw: 'provider-defined', openAi: 'other', accepted: true },
  { label: 'other without raw', unified: 'other', raw: undefined, accepted: false },
  { label: 'error', unified: 'error', raw: 'provider-error', accepted: false },
  { label: 'outside union', unified: 'not-a-finish-reason', raw: 'provider-outside', accepted: false },
] as const;

function finishPartForTest(testCase: typeof finishReasonCases[number]) {
  return {
    finishReason: testCase.unified,
    ...(testCase.raw === undefined ? {} : { rawFinishReason: testCase.raw }),
  };
}

function expectedFinishFailure(testCase: typeof finishReasonCases[number]): string {
  return `unified=${testCase.unified}${testCase.raw === undefined ? '' : ` raw=${testCase.raw}`}`;
}

/** Observes the parent-notice channel, which is where request-time warnings go
 *  now: `clodex claude` mutes the parent's stdio for Claude Code's TUI, so a
 *  console.error here would never reach a user. */
function captureNotices(): { lines: string[]; release: () => void } {
  const lines: string[] = [];
  return { lines, release: installParentNoticeSink(line => lines.push(line)) };
}

vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn((spec: unknown) => spec),
  jsonSchema: vi.fn((schema: unknown) => schema),
}));

describe('configured upstream retries', () => {
  it('passes the retry budget to streaming responses', async () => {
    const previous = process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
    process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = '4';
    async function* stream() {
      yield { type: 'finish', finishReason: 'stop' };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);

    try {
      await streamOpenAiResponse({} as never, { messages: [] }, 'test-model', () => {});

      expect(vi.mocked(streamText).mock.calls[0]![0].maxRetries).toBe(4);
    } finally {
      if (previous === undefined) delete process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
      else process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = previous;
      vi.mocked(streamText).mockReset();
    }
  });

  it('passes the retry budget to collected stream responses', async () => {
    const previous = process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
    process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = '4';
    async function* stream() {
      yield { type: 'finish', finishReason: 'stop' };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);

    try {
      await generateOpenAiResponse(
        {} as never,
        { messages: [] },
        'test-model',
        { forceStream: true },
      );

      expect(vi.mocked(streamText).mock.calls[0]![0].maxRetries).toBe(4);
    } finally {
      if (previous === undefined) delete process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
      else process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = previous;
      vi.mocked(streamText).mockReset();
    }
  });

  it('passes the retry budget to non-streaming responses', async () => {
    const previous = process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
    process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = '4';
    vi.mocked(generateText).mockResolvedValue({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);

    try {
      await generateOpenAiResponse({} as never, { messages: [] }, 'test-model');

      expect(vi.mocked(generateText).mock.calls[0]![0].maxRetries).toBe(4);
    } finally {
      if (previous === undefined) delete process.env['CLODEX_UPSTREAM_MAX_RETRIES'];
      else process.env['CLODEX_UPSTREAM_MAX_RETRIES'] = previous;
      vi.mocked(generateText).mockReset();
    }
  });
});

describe('streamOpenAiResponse', () => {
  it('propagates an SDK error instead of completing a failed stream', async () => {
    const upstreamError = { statusCode: 429, message: 'rate limited' };
    async function* stream() {
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'error', error: upstreamError };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    let output = '';

    await expect(streamOpenAiResponse(
      {} as never,
      { messages: [] },
      'gpt-test',
      chunk => { output += chunk; },
    )).rejects.toBe(upstreamError);

    expect(output).toContain('partial');
    expect(output).not.toContain('[DONE]');
  });

  it('rejects a synthesized finish after the upstream stream ends without a terminal event', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'finish', finishReason: 'other', rawFinishReason: undefined };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    let output = '';

    await expect(streamOpenAiResponse(
      {} as never,
      { messages: [] },
      'gpt-test',
      chunk => { output += chunk; },
    )).rejects.toThrow('Upstream OpenAI stream ended without a terminal event');

    expect(output).toContain('partial');
    expect(output).not.toContain('"finish_reason":"other"');
    expect(output).not.toContain('[DONE]');
  });

  it('settles the watchdog when streaming creation throws synchronously', async () => {
    vi.useFakeTimers();
    const originalError = new Error('stream creation failed');
    vi.mocked(streamText).mockImplementation(() => {
      throw originalError;
    });
    let output = '';

    try {
      await expect(streamOpenAiResponse(
        {} as never,
        { messages: [] },
        'gpt-test',
        chunk => { output += chunk; },
      )).rejects.toBe(originalError);
      expect(output).not.toContain('[DONE]');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.mocked(streamText).mockReset();
    }
  });

  it('accepts a provider-defined other finish reason', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'complete' };
      yield { type: 'finish', finishReason: 'other', rawFinishReason: 'provider-defined' };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    let output = '';

    await streamOpenAiResponse(
      {} as never,
      { messages: [] },
      'gpt-test',
      chunk => { output += chunk; },
    );

    expect(output).toContain('"finish_reason":"other"');
    expect(output).toContain('[DONE]');
  });
});

describe('translateOpenAiRequest OAuth shaping', () => {
  it('moves the system prompt into providerOptions and drops the output limit for OAuth routes', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    try {
      delete process.env.CLODEX_SERVICE_TIER;
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'hi' },
        ],
      }, { openAiOAuth: true });

      expect(params.instructions).toBeUndefined();
      expect(params.maxOutputTokens).toBeUndefined();
      expect(params.providerOptions).toEqual({
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          instructions: 'Be terse.',
        },
      });
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
    }
  });

  it('applies CLODEX_SERVICE_TIER on the OAuth route of the OpenAI-format endpoint too', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      const oauth = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });
      expect((oauth.providerOptions?.openai as Record<string, unknown>)?.serviceTier).toBe('priority');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
    }
  });

  it('defaults OAuth instructions when the request has no system prompt', async () => {
    const params = translateOpenAiRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    }, { openAiOAuth: true });

    expect((params.providerOptions as any)?.openai?.instructions).toBe('You are a coding assistant.');
  });

  it('keeps standard instructions and output limit for non-OAuth routes', async () => {
    const params = translateOpenAiRequest({
      model: 'gpt-test',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(params.instructions).toBe('Be terse.');
    expect(params.maxOutputTokens).toBe(100);
    expect(params.providerOptions).toBeUndefined();
  });
});

describe('collectOpenAiStream', () => {
  it('aggregates text deltas, tool calls, finish reason, and usage', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'Hello ' };
      yield { type: 'text-delta', text: 'world' };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Austin' } };
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
    }

    const collected = await collectOpenAiStream(stream());

    expect(collected.text).toBe('Hello world');
    expect(collected.toolCalls).toEqual([{ toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Austin' } }]);
    expect(collected.finishReason).toBe('tool-calls');
    expect(collected.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  });

  it.each(['length', 'content-filter'])('accepts a genuine %s finish reason', async finishReason => {
    async function* stream() {
      yield { type: 'text-delta', text: 'complete' };
      yield { type: 'finish', finishReason };
    }

    await expect(collectOpenAiStream(stream()))
      .resolves.toMatchObject({ text: 'complete', finishReason });
  });

  it.each(finishReasonCases)('handles $label in the collected-stream path', async testCase => {
    async function* stream() {
      yield { type: 'text-delta', text: 'complete' };
      yield { type: 'finish', ...finishPartForTest(testCase) };
    }

    const result = collectOpenAiStream(stream());
    if (testCase.accepted) {
      await expect(result).resolves.toMatchObject({
        text: 'complete',
        finishReason: testCase.unified,
      });
    } else {
      await expect(result).rejects.toThrow(expectedFinishFailure(testCase));
    }
  });

  it('propagates an SDK error part instead of returning a partial result', async () => {
    const upstreamError = { statusCode: 500, message: 'upstream exploded' };
    async function* stream() {
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'error', error: upstreamError };
    }

    await expect(collectOpenAiStream(stream())).rejects.toBe(upstreamError);
  });

  it('rejects EOF without a finish event instead of returning partial output', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'partial' };
    }

    await expect(collectOpenAiStream(stream()))
      .rejects.toThrow('Upstream OpenAI stream ended without a terminal event');
  });
});

describe('generateOpenAiResponse with forceStream', () => {
  it('streams upstream and synthesizes a complete non-streaming chat completion', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'pong' };
      yield { type: 'tool-call', toolCallId: 'call_9', toolName: 'lookup', input: { q: 'x' } };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    vi.mocked(generateText).mockClear();

    const response: any = await generateOpenAiResponse(
      {} as never,
      { messages: [] },
      'gpt-test',
      { forceStream: true },
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(response.object).toBe('chat.completion');
    expect(response.model).toBe('gpt-test');
    expect(response.choices).toEqual([{
      index: 0,
      message: {
        role: 'assistant',
        content: 'pong',
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      finish_reason: 'stop',
    }]);
    expect(response.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it('rejects a partial force-stream response with only a synthesized finish', async () => {
    async function* stream() {
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'finish', finishReason: 'other', rawFinishReason: undefined };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);

    await expect(generateOpenAiResponse(
      {} as never,
      { messages: [] },
      'gpt-test',
      { forceStream: true },
    )).rejects.toThrow('Upstream OpenAI stream ended without a terminal event');
  });

  it('settles the watchdog when force-stream creation throws synchronously', async () => {
    vi.useFakeTimers();
    const originalError = new Error('stream creation failed');
    vi.mocked(streamText).mockImplementation(() => {
      throw originalError;
    });

    try {
      await expect(generateOpenAiResponse(
        {} as never,
        { messages: [] },
        'gpt-test',
        { forceStream: true },
      )).rejects.toBe(originalError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.mocked(streamText).mockReset();
    }
  });

  it('uses a non-streaming upstream request when forceStream is not set', async () => {
    vi.mocked(streamText).mockClear();
    vi.mocked(generateText).mockResolvedValue({
      text: 'plain',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);

    const response: any = await generateOpenAiResponse({} as never, { messages: [] }, 'gpt-test');

    expect(streamText).not.toHaveBeenCalled();
    expect(response.choices[0].message.content).toBe('plain');
    expect(response.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });
});

describe('ordinary OpenAI terminal validation', () => {
  it.each([
    ['absent', { text: 'partial', toolCalls: [] }],
    ['synthetic other', {
      text: 'partial',
      toolCalls: [],
      finishReason: 'other',
      rawFinishReason: undefined,
    }],
  ])('rejects %s terminal output before assembling success', async (_label, result) => {
    vi.mocked(generateText).mockResolvedValue(result as never);

    try {
      await expect(generateOpenAiResponse(
        {} as never,
        { messages: [] },
        'gpt-test',
      )).rejects.toThrow('Upstream SDK stream ended without a terminal event');
    } finally {
      vi.mocked(generateText).mockReset();
    }
  });

  it('accepts a provider-defined other finish reason', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'complete',
      toolCalls: [],
      finishReason: 'other',
      rawFinishReason: 'provider-defined',
    } as never);

    try {
      const response: any = await generateOpenAiResponse({} as never, { messages: [] }, 'gpt-test');
      expect(response.choices[0].finish_reason).toBe('other');
    } finally {
      vi.mocked(generateText).mockReset();
    }
  });

  it.each(finishReasonCases)('handles $label in the generated/non-streaming path', async testCase => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'complete',
      toolCalls: [],
      ...finishPartForTest(testCase),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);

    try {
      const result = generateOpenAiResponse({} as never, { messages: [] }, 'gpt-test');
      if (testCase.accepted) {
        const response: any = await result;
        expect(response.choices[0].finish_reason).toBe(testCase.openAi);
      } else {
        await expect(result).rejects.toThrow(expectedFinishFailure(testCase));
      }
    } finally {
      vi.mocked(generateText).mockReset();
    }
  });

  it.each(finishReasonCases)('handles $label in the streamed writer', async testCase => {
    async function* stream() {
      yield { type: 'text-delta', text: 'complete' };
      yield { type: 'finish', ...finishPartForTest(testCase) };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    let output = '';

    try {
      const result = streamOpenAiResponse(
        {} as never,
        { messages: [] },
        'gpt-test',
        chunk => { output += chunk; },
      );
      if (testCase.accepted) {
        await result;
        expect(output).toContain(`\"finish_reason\":\"${testCase.openAi}\"`);
        expect(output).toContain('[DONE]');
      } else {
        await expect(result).rejects.toThrow(expectedFinishFailure(testCase));
        expect(output).not.toContain(`\"finish_reason\":\"${testCase.unified}\"`);
        expect(output).not.toContain('[DONE]');
      }
    } finally {
      vi.mocked(streamText).mockReset();
    }
  });

  it('rejects a late success after the total deadline aborts the request', async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: unknown) => void;
    vi.mocked(generateText).mockImplementation((() => new Promise(resolve => {
      resolveLate = resolve;
    })) as never);

    try {
      const settled = generateOpenAiResponse({} as never, { messages: [] }, 'gpt-test')
        .then(() => undefined, reason => reason);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      resolveLate({
        text: 'late',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });

      const error = await settled;
      expect(error).toMatchObject({ category: 'total_timeout' });
    } finally {
      vi.useRealTimers();
      vi.mocked(generateText).mockReset();
    }
  });
});

describe('OpenAI-format service tier omission warning', () => {
  it('surfaces the structured tier omission warning on non-streaming responses, once per process', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    const notices = captureNotices();
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      resetServiceTierWarningForTests();
      vi.mocked(generateText).mockResolvedValue({
        text: 'plain',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [{ type: 'unsupported', feature: 'serviceTier' }],
      } as never);
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });

      await generateOpenAiResponse({} as never, params, 'gpt-test');
      await generateOpenAiResponse({} as never, params, 'gpt-test');

      expect(notices.lines).toHaveLength(1);
      expect(notices.lines[0]).toContain('requested service tier was not sent');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
      resetServiceTierWarningForTests();
      notices.release();
      vi.mocked(generateText).mockReset();
    }
  });

  it('surfaces the structured tier omission warning on force-stream responses, once per process', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    const notices = captureNotices();
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      resetServiceTierWarningForTests();
      async function* stream() {
        yield { type: 'finish', finishReason: 'stop' };
      }
      vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });

      await generateOpenAiResponse({} as never, params, 'gpt-test', { forceStream: true });

      const onStepFinish = vi.mocked(streamText).mock.calls[0]![0].onStepFinish;
      expect(onStepFinish).toBeTypeOf('function');
      const step = { warnings: [{ type: 'unsupported', feature: 'serviceTier' }] } as never;
      onStepFinish?.(step);
      onStepFinish?.(step);

      expect(notices.lines).toHaveLength(1);
      expect(notices.lines[0]).toContain('requested service tier was not sent');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
      resetServiceTierWarningForTests();
      notices.release();
      vi.mocked(streamText).mockReset();
    }
  });

  it('surfaces the structured tier omission warning on streaming responses, once per process', async () => {
    const prior = process.env.CLODEX_SERVICE_TIER;
    const notices = captureNotices();
    try {
      process.env.CLODEX_SERVICE_TIER = 'fast';
      resetServiceTierWarningForTests();
      async function* stream() {
        yield { type: 'finish', finishReason: 'stop' };
      }
      vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
      const params = translateOpenAiRequest({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }, { openAiOAuth: true });

      await streamOpenAiResponse({} as never, params, 'gpt-test', () => {});

      const onStepFinish = vi.mocked(streamText).mock.calls[0]![0].onStepFinish;
      expect(onStepFinish).toBeTypeOf('function');
      const step = { warnings: [{ type: 'unsupported', feature: 'serviceTier' }] } as never;
      onStepFinish?.(step);
      onStepFinish?.(step);

      expect(notices.lines).toHaveLength(1);
      expect(notices.lines[0]).toContain('requested service tier was not sent');
    } finally {
      if (prior === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = prior;
      resetServiceTierWarningForTests();
      notices.release();
      vi.mocked(streamText).mockReset();
    }
  });
});

describe('OpenAI provider liveness deadlines', () => {
  /** A stream that produces nothing and dies only when the caller aborts it. */
  function mockHangingStream(): void {
    vi.mocked(streamText).mockImplementation(((options: { abortSignal?: AbortSignal }) => ({
      stream: (async function* (): AsyncGenerator<never> {
        await new Promise<never>((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(options.abortSignal?.reason ?? new Error('aborted')),
          );
        });
      })(),
    })) as never);
  }

  it('aborts a stream that never produces its first event, without completing it', async () => {
    vi.useFakeTimers();
    mockHangingStream();
    let output = '';

    try {
      const settled = streamOpenAiResponse(
        {} as never,
        { messages: [] },
        'gpt-test',
        chunk => { output += chunk; },
      ).then(() => undefined, reason => reason);

      await vi.advanceTimersByTimeAsync(120_000);
      const error = await settled;

      expect(sdkTimeoutDetails(error)).toEqual({
        category: 'idle_timeout',
        elapsedMs: 120_000,
        limitMs: 120_000,
        outputBegan: false,
      });
      // The deadline stops upstream work rather than only abandoning the read.
      expect(vi.mocked(streamText).mock.calls[0]![0].abortSignal?.aborted).toBe(true);
      expect(output).toBe('');
    } finally {
      vi.useRealTimers();
      vi.mocked(streamText).mockReset();
    }
  });

  it('restarts the idle deadline on every event, so a productive stream is never cut off', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGap = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGap = new Promise<void>(resolve => { releaseSecond = resolve; });
    async function* stream() {
      yield { type: 'text-delta', text: 'one' };
      await firstGap;
      yield { type: 'text-delta', text: 'two' };
      await secondGap;
      yield { type: 'finish', finishReason: 'stop' };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    let output = '';

    try {
      const settled = streamOpenAiResponse(
        {} as never,
        { messages: [] },
        'gpt-test',
        chunk => { output += chunk; },
      ).then(() => undefined, reason => reason);

      // Three gaps just under the deadline: 357s total, no single silent gap.
      await vi.advanceTimersByTimeAsync(119_000);
      releaseFirst();
      await vi.advanceTimersByTimeAsync(119_000);
      releaseSecond();
      await vi.advanceTimersByTimeAsync(119_000);

      expect(await settled).toBeUndefined();
      expect(output).toContain('one');
      expect(output).toContain('two');
      expect(output).toContain('[DONE]');
    } finally {
      vi.useRealTimers();
      vi.mocked(streamText).mockReset();
    }
  });

  it('applies the same idle deadline to a force-stream collection', async () => {
    vi.useFakeTimers();
    mockHangingStream();

    try {
      const settled = generateOpenAiResponse(
        {} as never,
        { messages: [] },
        'gpt-test',
        { forceStream: true },
      ).then(() => undefined, reason => reason);

      await vi.advanceTimersByTimeAsync(120_000);
      const error = await settled;

      expect(sdkTimeoutDetails(error)).toMatchObject({
        category: 'idle_timeout',
        limitMs: 120_000,
        outputBegan: false,
      });
      // Not the generic missing-terminal failure: the local deadline is the cause.
      expect((error as Error).message).not.toContain('without a terminal event');
      expect(vi.mocked(streamText).mock.calls[0]![0].abortSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.mocked(streamText).mockReset();
    }
  });

  it('applies the absolute ceiling to an ordinary non-streaming generation', async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockImplementation(((options: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener(
          'abort',
          () => reject(options.abortSignal?.reason ?? new Error('aborted')),
        );
      })) as never);

    try {
      const settled = generateOpenAiResponse({} as never, { messages: [] }, 'gpt-test')
        .then(() => undefined, reason => reason);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const error = await settled;

      expect((error as Error).message).toContain('provider request exceeded 600s');
      expect(sdkTimeoutDetails(error)).toEqual({
        category: 'total_timeout',
        elapsedMs: 10 * 60_000,
        limitMs: 10 * 60_000,
        outputBegan: false,
      });
    } finally {
      vi.useRealTimers();
      vi.mocked(generateText).mockReset();
    }
  });

  it('leaves no deadline armed after a stream or a generation completes', async () => {
    vi.useFakeTimers();
    async function* stream() {
      yield { type: 'text-delta', text: 'hi' };
      yield { type: 'finish', finishReason: 'stop' };
    }
    vi.mocked(streamText).mockReturnValue({ stream: stream() } as never);
    vi.mocked(generateText).mockResolvedValue({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);
    let output = '';

    try {
      await streamOpenAiResponse({} as never, { messages: [] }, 'gpt-test', chunk => { output += chunk; });
      expect(output).toContain('[DONE]');
      expect(vi.getTimerCount()).toBe(0);

      await generateOpenAiResponse({} as never, { messages: [] }, 'gpt-test');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.mocked(streamText).mockReset();
      vi.mocked(generateText).mockReset();
    }
  });
});
