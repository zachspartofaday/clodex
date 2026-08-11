// src/registry/types.ts — native provider registry schema (no secrets)

import type { FreeStatus } from '../free-models.js';
import type { ModelRuntimeCompatibility } from '../model-runtime-compatibility.js';

export const REGISTRY_SCHEMA_VERSION = 1;

export type RegistrySubscriptionFilter = 'free';

export function normalizeModelRuntimeCompatibility(
  value: unknown,
): ModelRuntimeCompatibility | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const normalized: ModelRuntimeCompatibility = {};

  if (
    source.reasoningEffortMap
    && typeof source.reasoningEffortMap === 'object'
    && !Array.isArray(source.reasoningEffortMap)
  ) {
    const entries = Object.entries(source.reasoningEffortMap as Record<string, unknown>)
      .filter((entry): entry is [string, string | null] => (
        typeof entry[1] === 'string' || entry[1] === null
      ));
    if (entries.length > 0) normalized.reasoningEffortMap = Object.fromEntries(entries);
  }
  if (typeof source.supportsReasoningEffort === 'boolean') {
    normalized.supportsReasoningEffort = source.supportsReasoningEffort;
  }
  if (source.thinkingFormat === 'deepseek' || source.thinkingFormat === 'qwen') {
    normalized.thinkingFormat = source.thinkingFormat;
  }
  if (typeof source.requiresReasoningContentOnAssistantMessages === 'boolean') {
    normalized.requiresReasoningContentOnAssistantMessages = source.requiresReasoningContentOnAssistantMessages;
  }
  if (typeof source.supportsStore === 'boolean') normalized.supportsStore = source.supportsStore;
  if (typeof source.supportsDeveloperRole === 'boolean') {
    normalized.supportsDeveloperRole = source.supportsDeveloperRole;
  }
  if (
    source.maxTokensField === 'max_tokens'
    || source.maxTokensField === 'max_completion_tokens'
  ) {
    normalized.maxTokensField = source.maxTokensField;
  }
  if (typeof source.supportsLongCacheRetention === 'boolean') {
    normalized.supportsLongCacheRetention = source.supportsLongCacheRetention;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export interface CachedModel {
  id: string;
  name: string;
  upstreamModelId: string;
  family?: string;
  brand?: string;
  contextWindow?: number;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  isFree?: boolean;
  freeStatus?: FreeStatus;
  modelFormat: 'anthropic' | 'openai' | 'cloud-code';
  /** Per-model override — wins over provider-level api.npm */
  npm?: string;
  /** Per-model override — wins over provider-level api.url */
  apiUrl?: string;
  sourceBackend?: string;
  /** Provider-reported request parameters, e.g. OpenRouter supported_parameters. */
  supportedParameters?: string[];
  /** Broad model metadata: model can produce reasoning/thinking output. */
  reasoning?: boolean;
  /** Streaming/interleaved reasoning field name from metadata, e.g. reasoning_content. */
  interleavedReasoningField?: string;
  /** Backend capability: model requires the Responses-Lite request shape (x-openai-internal-codex-responses-lite). */
  useResponsesLite?: boolean;
  /** Backend capability: model must use the WebSocket Responses transport instead of HTTP. */
  preferWebSockets?: boolean;
  /** Supported input modalities preserved from curated provider metadata. */
  modalities?: ('text' | 'image')[];
  /** Provider-neutral per-model wire quirks. */
  compatibility?: ModelRuntimeCompatibility;
}

export interface RegistryProvider {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
  authRef: string;
  authType?: 'api' | 'oauth' | 'none';
  subscriptionFilter?: RegistrySubscriptionFilter;
  /** Keep provider/curated costs instead of replacing them with the global pricing cache. */
  preserveModelPricing?: boolean;
  api: {
    npm?: string;
    url?: string;
    id?: string;
    /** Static headers sent on every upstream request (e.g. a plan/auth-tracking header a custom endpoint requires). */
    headers?: Record<string, string>;
  };
  modelsCache?: {
    fetchedAt: string;
    models: CachedModel[];
  };
  addedAt: string;
  refreshedAt?: string;
}

export interface ProviderRegistry {
  schemaVersion: number;
  providers: RegistryProvider[];
  importedAt?: string;
  pricingCacheAt?: string;
}
