import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

const state = vi.hoisted(() => ({
  registry: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const credential = vi.hoisted(() => ({
  resolve: vi.fn(),
  accountId: vi.fn(),
  providerData: vi.fn(),
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderCredentialWithSource: credential.resolve,
  resolveProviderOAuthAccountId: credential.accountId,
  resolveProviderOAuthProviderData: credential.providerData,
}));

vi.mock('../src/registry/io.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/io.js')>(),
  loadRegistry: vi.fn(() => structuredClone(state.registry)),
}));

import { loadRegistryProviders } from '../src/registry/load.js';

function oauthProvider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai-oauth',
    templateId: 'openai',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
    authType: 'oauth',
    api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
    modelsCache: {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'gpt-test',
        name: 'GPT Test',
        upstreamModelId: 'gpt-test',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
      }],
    },
    addedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('runtime registry credential attribution', () => {
  beforeEach(() => {
    state.registry = { schemaVersion: 1, providers: [oauthProvider()] };
    credential.resolve.mockReset();
    credential.accountId.mockReset().mockResolvedValue('selected-account-id');
    credential.providerData.mockReset().mockResolvedValue({ plan: 'pro' });
  });

  it('does not attach selected-account metadata to a provider-override token', async () => {
    state.registry = {
      schemaVersion: 3,
      providers: [oauthProvider({
        activeAuthAccount: 'work',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      })],
    };
    credential.resolve.mockResolvedValue({
      credential: 'provider-override-token',
      credentialOverride: {
        variable: 'CLODEX_KEY_OPENAI_OAUTH',
        fingerprint: 'a'.repeat(64),
      },
    });

    const providers = await loadRegistryProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]?.apiKey).toBe('provider-override-token');
    expect(providers[0]?.oauthAccountId).toBeUndefined();
    expect(providers[0]?.providerData).toBeUndefined();
    expect(credential.resolve).toHaveBeenCalledWith(
      'openai-oauth',
      'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
      undefined,
    );
    expect(credential.accountId).not.toHaveBeenCalled();
    expect(credential.providerData).not.toHaveBeenCalled();
  });

  it('retains selected-account metadata when the stored credential wins', async () => {
    credential.resolve.mockResolvedValue({ credential: 'stored-oauth-token' });

    const providers = await loadRegistryProviders();

    expect(providers[0]).toMatchObject({
      apiKey: 'stored-oauth-token',
      oauthAccountId: 'selected-account-id',
      providerData: { plan: 'pro' },
    });
    expect(credential.accountId).toHaveBeenCalledWith(
      'keyring:oauth:provider:openai-oauth::credential::v1:default',
      undefined,
    );
  });

  it('fails a broken OAuth selection before resolving the provider override', async () => {
    state.registry = {
      schemaVersion: 3,
      providers: [oauthProvider({
        activeAuthAccount: 'ghost',
        authAccounts: {
          work: {
            authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
            addedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      })],
    };
    credential.resolve.mockResolvedValue({
      credential: 'provider-override-token',
      credentialOverride: {
        variable: 'CLODEX_KEY_OPENAI_OAUTH',
        fingerprint: 'b'.repeat(64),
      },
    });

    await expect(loadRegistryProviders()).rejects.toThrow(/no longer exists/);
    expect(credential.resolve).not.toHaveBeenCalled();
  });
});
