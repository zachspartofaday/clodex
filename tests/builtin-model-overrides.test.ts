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

  it('matches across context-suffix variants and injects the CURRENT spelling', () => {
    const normalize = (id: string) => id.replace(/\[1m\]$/i, '');
    // Provider metadata moved the model across the 1M threshold: the saved
    // remap has the old spelling, the loaded route the new one. Both
    // directions must match, and the injected value must be the current
    // route spelling so the context hint reaches auto-compaction.
    expect(routableBuiltinOverrides(
      { fable: 'clodex:opencode-go:kimi-k3' }, ['clodex:opencode-go:kimi-k3[1m]'], undefined, normalize,
    )).toEqual({ fable: 'clodex:opencode-go:kimi-k3[1m]' });
    expect(routableBuiltinOverrides(
      { fable: 'clodex:opencode-go:kimi-k3[1m]' }, ['clodex:opencode-go:kimi-k3'], undefined, normalize,
    )).toEqual({ fable: 'clodex:opencode-go:kimi-k3' });
  });

  it('matches case-insensitively but injects the canonical routable spelling', () => {
    // The MITM route lookup is case-sensitive: injecting the saved "WJudge"
    // would pass the filter yet miss the route and go upstream unknown.
    expect(routableBuiltinOverrides({ opus: '  WJudge ' }, ['wjudge'])).toEqual({ opus: 'wjudge' });
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

  it('a corrupted sentinel neither breaks the launch nor claims explicit values', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'user-explicit',
      [WRAPPER_INJECTED_BUILTINS_ENV]: 'fable=%',
    };
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    // decodeURIComponent('%') throws URIError; the malformed entry is
    // ignored — never granted a match-any claim that would delete a var the
    // user set explicitly. Explicit env keeps winning over the snapshot.
    expect(() => applyBuiltinModelOverridesWithProvenance(env, { fable: 'snapshot' }, baseEnv)).not.toThrow();
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('user-explicit');
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
  const alive = () => true;
  const dead = () => false;

  it('requires marker agreement with the proxy var AND a live owner', () => {
    const session = {
      HTTPS_PROXY: 'http://127.0.0.1:17645',
      CLODEX_SESSION_PROXY: '17645:12345',
    };
    expect(insideSessionProxy(session, alive)).toBe(true);
    // A crashed session must fall through to the no-server path instead of
    // sending every request to a dead port.
    expect(insideSessionProxy(session, dead)).toBe(false);
  });

  it('never preserves for stale, legacy, or foreign shapes', () => {
    // Port-only legacy markers are unverifiable.
    expect(insideSessionProxy({ HTTPS_PROXY: 'http://127.0.0.1:17645', CLODEX_SESSION_PROXY: '17645' }, alive)).toBe(false);
    expect(insideSessionProxy({ CLODEX_SESSION_PROXY: '17645:12345' }, alive)).toBe(false);
    expect(insideSessionProxy({ HTTPS_PROXY: 'http://127.0.0.1:17645' }, alive)).toBe(false);
    expect(insideSessionProxy({ HTTPS_PROXY: 'http://127.0.0.1:9999', CLODEX_SESSION_PROXY: '17645:12345' }, alive)).toBe(false);
    expect(insideSessionProxy({ HTTPS_PROXY: 'http://corp-proxy:8080', CLODEX_SESSION_PROXY: '8080:12345' }, alive)).toBe(false);
    expect(insideSessionProxy({}, alive)).toBe(false);
  });
});
