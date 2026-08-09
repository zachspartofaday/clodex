/**
 * Provider-neutral per-model compatibility hints.
 *
 * These describe Chat Completions wire quirks that cannot be inferred safely
 * from a provider or model family. Runtime adapters consume only the fields
 * they understand; unknown fields remain inert metadata.
 */
export interface ModelRuntimeCompatibility {
  /** Claude/Codex effort -> upstream reasoning_effort map. null disables that level. */
  reasoningEffortMap?: Record<string, string | null>;
  /** Explicitly enable or disable reasoning_effort for this model. */
  supportsReasoningEffort?: boolean;
  /** Additional request shape required when reasoning is enabled. */
  thinkingFormat?: 'deepseek' | 'qwen';
  /**
   * Wire effort value → reasoning-token budget, for an upstream that grades
   * thinking by budget rather than by an effort word.
   *
   * Qwen is the case: it accepts no `reasoning_effort` at all, and OpenCode's
   * reference client sends `thinking: {type:'enabled', budgetTokens: N}` with
   * one budget per grade. Keyed by the mapped wire value so the transform can
   * resolve a budget from the request it is already holding, without needing
   * to know which clodex level produced it. When present with
   * `thinkingFormat: 'qwen'`, `reasoning_effort` is REPLACED by the thinking
   * object rather than sent alongside it — the upstream ignores the former.
   */
  thinkingBudgetMap?: Record<string, number>;
  /** Replay an empty reasoning_content field when prior assistant reasoning is absent. */
  requiresReasoningContentOnAssistantMessages?: boolean;
  /** Whether the upstream accepts the OpenAI `store` request field. */
  supportsStore?: boolean;
  /** Whether the upstream accepts Chat Completions `developer` messages. */
  supportsDeveloperRole?: boolean;
  /** Output-token field accepted by the upstream Chat Completions endpoint. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Whether the upstream accepts long prompt-cache retention controls. */
  supportsLongCacheRetention?: boolean;
  /**
   * Whether an anthropic-format upstream implements
   * `POST /v1/messages/count_tokens`. Speaking the Messages API does not imply
   * it — OpenCode Zen documents `/v1/responses`, `/v1/chat/completions` and
   * `/v1/messages` and no token-counting endpoint — and forwarding a count to
   * an upstream without it answers the client's token accounting with a 404
   * instead of a number. Only an explicit `false` diverts to the local
   * estimate; unset keeps forwarding, so a custom Anthropic-compatible
   * endpoint that does implement it is unaffected.
   */
  supportsCountTokens?: boolean;
}

export type OpenAiCompatibleRequestBody = Record<string, unknown>;

type ChatMessage = Record<string, unknown> & { role?: unknown };

function remapMaxTokensField(
  body: OpenAiCompatibleRequestBody,
  field: ModelRuntimeCompatibility['maxTokensField'],
): void {
  if (field === 'max_tokens') {
    if (body.max_tokens === undefined && body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens;
    }
    delete body.max_completion_tokens;
    return;
  }
  if (field === 'max_completion_tokens') {
    if (body.max_completion_tokens === undefined && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens;
    }
    delete body.max_tokens;
  }
}

function transformMessages(
  messages: unknown,
  compatibility: ModelRuntimeCompatibility,
): unknown {
  if (!Array.isArray(messages)) return messages;
  const rewriteDeveloper = compatibility.supportsDeveloperRole === false;
  const replayReasoning = compatibility.requiresReasoningContentOnAssistantMessages === true;
  if (!rewriteDeveloper && !replayReasoning) return messages;

  let changed = false;
  const transformed = messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const source = message as ChatMessage;
    const role = source.role;
    const needsRoleRewrite = rewriteDeveloper && role === 'developer';
    const needsReasoningReplay = replayReasoning
      && role === 'assistant'
      && !Object.prototype.hasOwnProperty.call(source, 'reasoning_content');
    if (!needsRoleRewrite && !needsReasoningReplay) return message;

    changed = true;
    return {
      ...source,
      ...(needsRoleRewrite ? { role: 'system' } : {}),
      ...(needsReasoningReplay ? { reasoning_content: '' } : {}),
    };
  });

  return changed ? transformed : messages;
}

/**
 * Apply model-specific OpenAI-compatible request quirks after the AI SDK has
 * assembled its Chat Completions payload.
 */
export function transformOpenAiCompatibleRequestBody(
  body: OpenAiCompatibleRequestBody,
  compatibility: ModelRuntimeCompatibility,
): OpenAiCompatibleRequestBody {
  const transformed = { ...body };

  if (compatibility.supportsStore === false) delete transformed.store;
  if (compatibility.supportsLongCacheRetention === false) {
    delete transformed.prompt_cache_retention;
    delete transformed.promptCacheRetention;
  }
  remapMaxTokensField(transformed, compatibility.maxTokensField);

  const messages = transformMessages(transformed.messages, compatibility);
  if (messages !== transformed.messages) transformed.messages = messages;

  const hasReasoningEffort = typeof transformed.reasoning_effort === 'string'
    && transformed.reasoning_effort.trim().length > 0;
  if (hasReasoningEffort && compatibility.thinkingFormat === 'deepseek') {
    if (transformed.thinking === undefined) transformed.thinking = { type: 'enabled' };
  } else if (hasReasoningEffort && compatibility.thinkingFormat === 'qwen') {
    const budget = compatibility.thinkingBudgetMap?.[String(transformed.reasoning_effort)];
    if (budget !== undefined) {
      // The graded form: a budget per level, which is what the upstream
      // actually reads. `reasoning_effort` is dropped rather than sent
      // alongside — Qwen ignores it, and leaving it in makes the request
      // look like it carries a control it does not.
      if (transformed.thinking === undefined) {
        transformed.thinking = { type: 'enabled', budgetTokens: budget };
      }
      delete transformed.reasoning_effort;
    } else if (transformed.enable_thinking === undefined) {
      // No budget known for this value: fall back to the boolean toggle.
      transformed.enable_thinking = true;
    }
  }

  return transformed;
}
