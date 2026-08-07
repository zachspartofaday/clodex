import { describe, expect, it } from 'vitest';
import { applyBuiltinModelOverrides, BUILTIN_ALIAS_ENV } from '../src/env.js';
import { applyBuiltinModelOverridesWithProvenance, insideSessionProxy, routableBuiltinOverrides, WRAPPER_INJECTED_BUILTINS_ENV } from '../src/builtin-alias-env.js';
import { CONFLICTING_ENV_VARS } from '../src/constants.js';

describe('applyBuiltinModelOverrides', () => {
  it('injects configured overrides for every built-in alias', () => {
    const env: NodeJS.ProcessEnv = {};
    applyBuiltinModelOverrides(env, { sonnet: 'wfast', fable: 'wjudge' }, {});
    expect(env[BUILTIN_ALIAS_ENV.sonnet]).toBe('wfast');
    expect(env[BUILTIN_ALIAS_ENV.fable]).toBe('wjudge');
    expect(env[BUILTIN_ALIAS_ENV.opus]).toBeUndefined();
    expect(env[BUILTIN_ALIAS_ENV.haiku]).toBeUndefined();
  });

  it('an explicitly set environment variable wins over config', () => {
    const env: NodeJS.ProcessEnv = {};
    applyBuiltinModelOverrides(
      env,
      { sonnet: 'wfast' },
      { [BUILTIN_ALIAS_ENV.sonnet]: 'my-explicit-model' },
    );
    expect(env[BUILTIN_ALIAS_ENV.sonnet]).toBe('my-explicit-model');
  });

  it('ignores empty override values', () => {
    const env: NodeJS.ProcessEnv = {};
    applyBuiltinModelOverrides(env, { sonnet: '  ' }, {});
    expect(env[BUILTIN_ALIAS_ENV.sonnet]).toBeUndefined();
  });
});

describe('routableBuiltinOverrides', () => {
  it('keeps routable targets and reverts stale ones with a warning', () => {
    const warnings: string[] = [];
    const filtered = routableBuiltinOverrides(
      { fable: 'wjudge', sonnet: 'clodex:openai-oauth:gpt-5.6-sol', haiku: 'gone-alias' },
      ['wjudge', 'clodex:openai-oauth:gpt-5.6-sol'],
      message => warnings.push(message),
    );
    expect(filtered).toEqual({ fable: 'wjudge', sonnet: 'clodex:openai-oauth:gpt-5.6-sol' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('haiku → gone-alias');
  });

  it('matches routable names case-insensitively and trims targets', () => {
    expect(routableBuiltinOverrides({ opus: '  WJudge ' }, ['wjudge'])).toEqual({ opus: '  WJudge ' });
  });

  it('returns empty for undefined overrides', () => {
    expect(routableBuiltinOverrides(undefined, ['wjudge'])).toEqual({});
  });
});

describe('conflict sweep coverage', () => {
  it('sweeps every remappable built-in alias env var in endpoint mode', () => {
    for (const envName of Object.values(BUILTIN_ALIAS_ENV)) {
      // fable was missing from the list, so a pre-existing fable override
      // survived buildChildEnv and reached the local endpoint unswept.
      expect(CONFLICTING_ENV_VARS).toContain(envName);
    }
  });
});

describe('applyBuiltinModelOverridesWithProvenance', () => {
  it('a previous launch\'s injection never outranks the new snapshot', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'old-injected',
      [WRAPPER_INJECTED_BUILTINS_ENV]: 'fable',
    };
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    applyBuiltinModelOverridesWithProvenance(env, { fable: 'new-target' }, baseEnv);
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('new-target');
    expect(env[WRAPPER_INJECTED_BUILTINS_ENV]).toBe('fable=new-target');
  });

  it('clears a stale inherited injection the new launch does not re-issue', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'old-injected',
      [WRAPPER_INJECTED_BUILTINS_ENV]: 'fable',
    };
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    applyBuiltinModelOverridesWithProvenance(env, {}, baseEnv);
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
    expect(env[WRAPPER_INJECTED_BUILTINS_ENV]).toBeUndefined();
  });

  it('a user who replaced an injected var made it explicit — it survives and wins', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'user-replaced',
      [WRAPPER_INJECTED_BUILTINS_ENV]: `fable=${encodeURIComponent('old-injected')}`,
    };
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    applyBuiltinModelOverridesWithProvenance(env, { fable: 'snapshot' }, baseEnv);
    // The recorded value no longer matches, so the sentinel's claim is void:
    // the replacement is user-explicit and outranks the snapshot.
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('user-replaced');
    expect(env[WRAPPER_INJECTED_BUILTINS_ENV]).toBeUndefined();
  });

  it('a true user-set env var still outranks everything and is never claimed', () => {
    const baseEnv: NodeJS.ProcessEnv = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'user-pinned' };
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    applyBuiltinModelOverridesWithProvenance(env, { sonnet: 'snapshot', fable: 'wjudge' }, baseEnv);
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('user-pinned');
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('wjudge');
    // Only what THIS launch injected is claimed by the sentinel, with its value.
    expect(env[WRAPPER_INJECTED_BUILTINS_ENV]).toBe('fable=wjudge');
  });
});

describe('insideSessionProxy', () => {
  it('detects the per-session proxy shape and nothing else', () => {
    expect(insideSessionProxy({
      HTTPS_PROXY: 'http://127.0.0.1:17645',
      NODE_EXTRA_CA_CERTS: '/home/u/.clodex/http-proxy/clodex-ca.pem',
    })).toBe(true);
    expect(insideSessionProxy({ HTTPS_PROXY: 'http://corp-proxy:8080' })).toBe(false);
    expect(insideSessionProxy({ HTTPS_PROXY: 'http://127.0.0.1:17645' })).toBe(false);
    expect(insideSessionProxy({})).toBe(false);
  });
});
