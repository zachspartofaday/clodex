// src/wrapper-env.ts
//
// Pure env computation for the `clodex-claude` wrapper bin. Given the process
// env and a live `clodex server` runtime state (or null), returns the env to
// launch the Claude Code binary with. Kept dependency-free so the wrapper
// stays tiny and fast — it runs for every Claude-Code-spawned agent process.

import type { ServerRuntimeState } from './server-runtime.js';
import type { BuiltinAliasName } from './types.js';
import { applyBuiltinModelOverridesWithProvenance, clearInheritedBuiltinOverrides, insideSessionProxy, SESSION_PROXY_ENV } from './builtin-alias-env.js';

const PROXY_ENV_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const;
export const REQUIRE_SERVER_ENV = 'CLODEX_REQUIRE_SERVER';

export function removeAnthropicProxyBypass(env: NodeJS.ProcessEnv): void {
  const noProxyValues = [env['NO_PROXY'], env['no_proxy']]
    .filter((value): value is string => value !== undefined);
  if (noProxyValues.length === 0) return;

  const filtered = [...new Set(noProxyValues
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => {
      const entry = value.toLowerCase().replace(/^https?:\/\//, '');
      const host = entry.replace(/:\d+$/, '');
      if (host === '*') return false;
      const suffix = host.startsWith('*.') ? host.slice(1) : host;
      const bypassesAnthropic = suffix.startsWith('.')
        ? 'api.anthropic.com'.endsWith(suffix)
        : 'api.anthropic.com' === suffix || 'api.anthropic.com'.endsWith(`.${suffix}`);
      return !bypassesAnthropic;
    }))]
    .join(',');
  if (filtered) {
    env['NO_PROXY'] = filtered;
    env['no_proxy'] = filtered;
  } else {
    delete env['NO_PROXY'];
    delete env['no_proxy'];
  }
}

/**
 * Any non-empty key satisfies the local endpoint gateway (`isAuthorized`
 * accepts everything when no server password is set, i.e. local listen mode).
 */
export const LOCAL_GATEWAY_API_KEY = 'clodex-local';

export function wrapperRequiresServer(env: NodeJS.ProcessEnv): boolean {
  return env[REQUIRE_SERVER_ENV] === '1';
}

/** kill(pid, 0) liveness: EPERM still means the process exists. */
function sessionProxyOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function computeWrapperEnv(
  baseEnv: NodeJS.ProcessEnv,
  state: ServerRuntimeState | null,
  builtinOverrides?: Partial<Record<BuiltinAliasName, string>>,
  opts?: { isAlive?: (pid: number) => boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // Remaps a previous launch injected are OUR state, not the user's: they
  // must never outlive the launch that issued them, or a no-server launch
  // sends the alias straight to Anthropic and an endpoint launch sends it to
  // a catalog that may not expose it. One exception: a wrapper invoked
  // INSIDE a live per-session proxy (which publishes no runtime record)
  // must keep that session's remap — the inherited proxy still routes it.
  // Everything else stays untouched — a down server must never break
  // launching claude.
  if (!state && insideSessionProxy(baseEnv, opts?.isAlive ?? sessionProxyOwnerAlive)) return env;
  // Every remaining path repoints or drops the routing this marker described.
  delete env[SESSION_PROXY_ENV];
  clearInheritedBuiltinOverrides(env, baseEnv);
  if (!state) return env;

  if (state.mode === 'proxy') {
    // Selective MITM: claude keeps its own Anthropic credentials; the proxy
    // routes clodex:/alias models to OpenAI and passes everything else through.
    const proxyUrl = `http://127.0.0.1:${state.port}`;
    delete env['ANTHROPIC_BASE_URL'];
    for (const name of PROXY_ENV_VARS) env[name] = proxyUrl;
    if (state.caPath) env['NODE_EXTRA_CA_CERTS'] = state.caPath;
    // The same built-in remap the per-session `clodex claude` proxy launch
    // applies (env.ts): saved sonnet/opus/haiku/fable overrides must also
    // reach a claude launched through a discovered standalone server, or the
    // remap silently depends on how claude was started. An env var the user
    // set explicitly still wins.
    applyBuiltinModelOverridesWithProvenance(env, builtinOverrides, baseEnv);
    removeAnthropicProxyBypass(env);
    return env;
  }

  // Endpoint gateway: all traffic goes to the local Anthropic-format gateway.
  for (const name of PROXY_ENV_VARS) delete env[name];
  env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${state.port}/anthropic`;
  env['ANTHROPIC_API_KEY'] = LOCAL_GATEWAY_API_KEY;
  return env;
}
