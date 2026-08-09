// src/registry/types.ts — native provider registry schema (no secrets)

import type { FreeStatus } from '../free-models.js';
import type { ModelRuntimeCompatibility } from '../model-runtime-compatibility.js';

export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Written whenever any provider carries named OAuth account slots. Older
 * builds fail closed on an unknown schema version in every MUTATING path
 * (parseRegistryStrict throws), so a downgraded or second installation
 * cannot load a slot-bearing registry, drop the unknown field, and save the
 * providers back slot-less — which would orphan the slot credentials. A
 * registry whose last slot is removed is written back at version 1, so
 * old builds interoperate again the moment no slot state exists.
 */
export const REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_SLOTS = 2;

/**
 * Written whenever any provider carries `activeAuthAccount`.
 *
 * A DISTINCT version, not a reuse of the slot version: a build from before the
 * stored selector existed accepts version 2, parses the slots, silently
 * ignores the unknown `activeAuthAccount`, and saves the registry back without
 * it. Version 3 stops that, because its strict loader throws on a version it
 * does not know. A registry whose selector is cleared falls back to 2 (or 1),
 * so older builds interoperate again as soon as no selector state exists.
 *
 * KNOWN LIMITATION — this fences MUTATION, not launches. Older builds reach
 * the registry through the lenient `loadRegistry()`, which never reads
 * `schemaVersion` at all, so a pre-selector installation sharing this
 * CLODEX_HOME still parses the provider, discards the selector it does not
 * know, and launches as the provider default. No version number can fix that:
 * the loader that would have to reject it has already shipped. Closing it
 * needs the persisted bytes to carry the selection somewhere an old build
 * already reads — pointing `authRef` at the selected slot and parking the
 * original elsewhere — which changes credential storage and is tracked
 * separately rather than bolted on here.
 */
export const REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT = 3;

/**
 * Shape rule for a named OAuth account-slot name — the single home. Slot
 * names land in credential-store scopes and env values, and the registry
 * parser must accept exactly what `validateOAuthAccountName` admits, or a
 * saved slot fails to survive a load.
 */
export const OAUTH_ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type RegistrySubscriptionFilter = 'free';

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
  /**
   * Named OAuth account slots beyond the default credential
   * (`clodex providers auth openai --account <name>`). Each slot owns a
   * disjoint credential-store lineage; CLODEX_OAUTH_ACCOUNT selects one at
   * launch without touching the default `authRef`.
   */
  authAccounts?: Record<string, { authRef: string; addedAt: string; oauthAccountId?: string }>;
  /**
   * The `authAccounts` slot every launch uses, so the running identity does not
   * depend on remembering an environment variable. Absent means the provider's
   * own default credential. CLODEX_OAUTH_ACCOUNT still overrides it for a
   * single run.
   *
   * Only the NAME SHAPE is enforced when the registry loads. A name that no
   * longer matches a slot is rejected at apply time instead: rejecting it at
   * load would drop the entire provider record, so a stale selector would make
   * the provider silently vanish from the CLI rather than say what is wrong.
   */
  activeAuthAccount?: string;
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
