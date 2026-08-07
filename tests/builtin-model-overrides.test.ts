import { describe, expect, it } from 'vitest';
import { applyBuiltinModelOverrides, BUILTIN_ALIAS_ENV } from '../src/env.js';

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
