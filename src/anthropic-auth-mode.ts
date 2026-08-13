import type { RegistryProvider } from './registry/types.js';

/**
 * Positive provenance for Anthropic-compatible endpoints whose API-key contract
 * is `x-api-key` only. Absence deliberately preserves the historical dual
 * Authorization + x-api-key envelope used by other proxied gateways.
 */
export const ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE = 'x-api-key-only' as const;

export type AnthropicAuthMode = typeof ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE;

/**
 * Derive the runtime auth envelope from the registry template that proved it.
 *
 * Keyed to the exact template ids that speak the Anthropic Messages contract,
 * never to a capability predicate such as "any anthropic-format route": the
 * dual envelope is what every other proxied gateway still receives.
 */
export function resolveAnthropicAuthMode(
  provider: Pick<RegistryProvider, 'templateId'>,
): AnthropicAuthMode | undefined {
  return provider.templateId === 'custom-anthropic' || provider.templateId === 'anthropic'
    ? ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE
    : undefined;
}
