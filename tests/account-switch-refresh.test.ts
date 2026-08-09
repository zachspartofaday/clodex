import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProviderCredentialWithSource } from '../src/env.js';
import { setActiveOAuthAccount } from '../src/registry/crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { refreshProviderModelsWithCredential } from '../src/registry/refresh-models.js';

vi.mock('../src/registry/fetch-template-models.js', () => ({
  fetchTemplateModels: vi.fn(),
}));

import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

describe('account-switch catalog lifecycle', () => {
  let home = '';
  const previousHome = process.env.CLODEX_HOME;
  const previousProviderOverride = process.env.CLODEX_KEY_GROQ;
  const previousAccountOverride = process.env.CLODEX_OAUTH_ACCOUNT;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-switch-refresh-'));
    process.env.CLODEX_HOME = home;
    delete process.env.CLODEX_KEY_GROQ;
    delete process.env.CLODEX_OAUTH_ACCOUNT;
    vi.mocked(fetchTemplateModels).mockReset();

    const registry = emptyRegistry();
    registry.providers.push({
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:default',
      authType: 'oauth',
      authAccounts: {
        work: {
          authRef: 'keyring:provider:work',
          addedAt: '2026-08-09T00:00:00.000Z',
        },
        alt: {
          authRef: 'keyring:provider:alt',
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      },
      api: { npm: '@ai-sdk/groq', url: 'https://api.groq.com/openai/v1' },
      modelsCache: {
        fetchedAt: '2026-08-09T00:00:00.000Z',
        models: [{
          id: 'default-only-model',
          name: 'Default-only model',
          upstreamModelId: 'default-only-model',
          modelFormat: 'openai',
        }],
      },
      addedAt: '2026-08-09T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousProviderOverride === undefined) delete process.env.CLODEX_KEY_GROQ;
    else process.env.CLODEX_KEY_GROQ = previousProviderOverride;
    if (previousAccountOverride === undefined) delete process.env.CLODEX_OAUTH_ACCOUNT;
    else process.env.CLODEX_OAUTH_ACCOUNT = previousAccountOverride;
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps the switched cache empty when a provider-key override later disappears', async () => {
    expect(setActiveOAuthAccount('groq', 'work')).toMatchObject({ changed: true });
    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
    process.env.CLODEX_KEY_GROQ = 'transient-provider-token';

    const result = await refreshProviderModelsWithCredential(
      'groq',
      provider => resolveProviderCredentialWithSource(provider.id, provider.authRef),
      null,
    );
    delete process.env.CLODEX_KEY_GROQ;

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: expect.stringContaining('CLODEX_KEY_GROQ is a process-scoped provider credential override'),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
  });

  it('keeps the switched cache empty when a different one-process account later disappears', async () => {
    expect(setActiveOAuthAccount('groq', 'work')).toMatchObject({ changed: true });
    process.env.CLODEX_OAUTH_ACCOUNT = 'alt';

    const result = await refreshProviderModelsWithCredential(
      'groq',
      async () => 'transient-alt-token',
      'alt',
    );
    delete process.env.CLODEX_OAUTH_ACCOUNT;

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: expect.stringContaining('CLODEX_OAUTH_ACCOUNT=alt temporarily selects a different account'),
    });
    expect(fetchTemplateModels).not.toHaveBeenCalled();
    expect(loadRegistry().providers[0]?.modelsCache).toBeUndefined();
  });
});
