import { describe, expect, it } from 'vitest';
import { applyBuiltinModelOverrides, BUILTIN_ALIAS_ENV } from '../src/env.js';
import { routableBuiltinOverrides } from '../src/builtin-alias-env.js';
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
