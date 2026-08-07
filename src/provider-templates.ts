// src/provider-templates.ts — builtin provider templates for clodex providers add

import type { CachedModel } from './registry/types.js';
import {
  buildOpenCodeGoModels,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_NAME,
} from './data/opencode-go-models.js';

export type ProviderAuthType = 'api' | 'oauth' | 'none';
export type ProviderModelSource = 'api-list' | 'static-seed' | 'manual-only';
export type ProviderStaticModelPolicy = 'overlay' | 'allowlist';
export type ProviderTemplateModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

export interface ProviderTemplate {
  id: string;
  name: string;
  authType: ProviderAuthType;
  npm: string;
  defaultBaseUrl?: string;
  modelsPath?: string;
  signupUrl?: string;
  urlPlaceholder?: string;
  urlPrompt?: string;
  apiKeyOptional?: boolean;
  anonymousFreeModels?: boolean;
  /** Static headers this provider requires on every request (model listing and runtime). */
  headers?: Record<string, string>;
  modelSource: ProviderModelSource;
  /** Curated model metadata layered over live discovery or used as a static seed. */
  staticModels?: ProviderTemplateModel[];
  /** `allowlist` hides live models absent from staticModels; `overlay` keeps them. */
  staticModelPolicy?: ProviderStaticModelPolicy;
  /** Keep provider/curated costs instead of replacing them with the global pricing cache. */
  preserveModelPricing?: boolean;
  supported: boolean;
  addable?: boolean;
  hidden?: boolean;
  unsupportedReason?: string;
}

/** Built-in providers available through `clodex providers add` or OAuth authentication. */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    authType: 'api',
    npm: '@ai-sdk/openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    modelSource: 'api-list',
    supported: true,
  },
  {
    id: OPENCODE_GO_PROVIDER_ID,
    name: OPENCODE_GO_PROVIDER_NAME,
    authType: 'api',
    npm: '@ai-sdk/openai-compatible',
    defaultBaseUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
    modelsPath: '/models',
    signupUrl: 'https://opencode.ai',
    modelSource: 'api-list',
    staticModels: buildOpenCodeGoModels(),
    staticModelPolicy: 'allowlist',
    preserveModelPricing: true,
    supported: true,
  },
  {
    id: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    authType: 'oauth',
    npm: '@ai-sdk/openai',
    signupUrl: 'https://chatgpt.com',
    modelSource: 'api-list',
    supported: true,
  },
];

export function listSupportedTemplates(): ProviderTemplate[] {
  return PROVIDER_TEMPLATES
    .filter(t => t.supported && t.authType === 'api' && t.addable !== false && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Supported templates not yet present in the user's registry. */
export function listAddableTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return listSupportedTemplates().filter(t => !configured.has(t.id));
}

export function listVisibleOAuthTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return PROVIDER_TEMPLATES
    .filter(t => t.authType === 'oauth' && t.supported && t.addable !== false && !t.hidden && !configured.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find(t => t.id === id);
}

export function filterTemplates(templates: ProviderTemplate[], query: string): ProviderTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  return templates.filter(
    t =>
      t.id.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.npm.toLowerCase().includes(q),
  );
}
