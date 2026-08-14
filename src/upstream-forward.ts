import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ServerResponse } from 'node:http';
import { sanitizeCredential } from './server/auth.js';
import {
  ANTHROPIC_BETA_HEADER,
  isAnthropicBetaHeaderName,
  resolveOutboundBeta,
  type AnthropicCapabilityRequest,
  type AnthropicCapabilityRouteFacts,
} from './anthropic-beta-policy.js';
import { isCredentialBearingHeader } from './credential-headers.js';
import { fetchWithoutRedirects } from './redirect-policy.js';
import { clampRetryAfterSeconds } from './upstream-error.js';
import {
  ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE,
  type AnthropicAuthMode,
} from './anthropic-auth-mode.js';

/**
 * Build the headers for a routed Anthropic-format upstream request.
 *
 * This is the final routed boundary, so it RECOMPUTES the beta set here: from
 * the provider's CONFIGURED headers, plus — only when `capability` is supplied —
 * the capability tokens this exact destination, route and body earn under
 * `anthropic-beta-policy`. The inbound client beta is one input to those
 * predicates and never a value to forward, so an arbitrary client beta still
 * cannot reach an upstream from here, and neither can a capability token whose
 * predicate is false. The credential scheme (api key, OAuth bearer, anonymous)
 * is unchanged, and no native-client identity is synthesized — clodex ships no
 * supported producer of native Claude credentials whose lineage such an
 * identity could represent.
 *
 * When the route owns the credential it owns it OUTRIGHT: every configured
 * credential-bearing header is removed before the route's canonical envelope
 * is added, so a second cookie/token/secret spelling cannot ride alongside it.
 * Ordinary configured headers are untouched.
 */
export function anthropicUpstreamHeaders(
  apiKey: string,
  stream = false,
  authType?: 'api' | 'oauth' | 'none',
  extraHeaders?: Record<string, string>,
  capability?: AnthropicCapabilityRequest,
  anthropicAuthMode?: AnthropicAuthMode,
): Record<string, string> {
  const key = sanitizeCredential(apiKey) ?? apiKey.trim();
  const resolvedAuthType = authType ?? 'api';
  const isOAuth = resolvedAuthType === 'oauth';
  const outboundBeta = resolveOutboundBeta(extraHeaders, capability);
  // Configured beta spellings are re-emitted once, normalized, under the
  // canonical name. Passing them through as well would leave two case-variant
  // keys on one request, which fetch appends into a single merged header — the
  // same failure the route-owned credential names are dropped to avoid.
  const forwardedExtraHeaders = Object.fromEntries(
    Object.entries(extraHeaders ?? {}).filter(([name]) =>
      !isAnthropicBetaHeaderName(name)
      && !isCredentialBearingHeader(name),
    ),
  );
  const headers: Record<string, string> = {
    ...forwardedExtraHeaders,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    // Anonymous sends no credential; OAuth is bearer-only; an API key defaults
    // to the historical dual envelope, and drops the redundant Authorization
    // copy only for a route whose template PROVED an x-api-key-only contract.
    ...(resolvedAuthType === 'none'
      ? {}
      : isOAuth
        ? { Authorization: `Bearer ${key}` }
        : anthropicAuthMode === ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE
          ? { 'x-api-key': key }
          : { Authorization: `Bearer ${key}`, 'x-api-key': key }),
    ...(stream ? { Accept: 'text/event-stream' } : {}),
  };
  if (outboundBeta.source !== 'none') {
    headers[ANTHROPIC_BETA_HEADER] = outboundBeta.value;
  }
  return headers;
}

export class UpstreamUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Upstream unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UpstreamUnreachableError';
  }
}

export async function resolveOAuthRetryReplacement(
  enabled: boolean,
  status: number,
  attempt: number,
  headersSent: boolean,
  apiKey: string,
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>,
): Promise<string | null> {
  if (!enabled || status !== 401 || attempt !== 0 || headersSent || !refreshToken) {
    return null;
  }
  const replacement = await refreshToken(apiKey).catch(() => null);
  return replacement && replacement !== apiKey ? replacement : null;
}

export async function fetchWithOAuthRetry<TResponse extends {
  status: number;
  body?: { cancel?: () => Promise<void> | void } | null;
}>(
  apiKey: string,
  request: (apiKey: string) => Promise<TResponse>,
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>,
): Promise<{ response: TResponse; apiKey: string; refreshed: boolean }> {
  let response = await request(apiKey);
  const refreshed = await resolveOAuthRetryReplacement(
    true,
    response.status,
    0,
    false,
    apiKey,
    refreshToken,
  );
  if (!refreshed) {
    return { response, apiKey, refreshed: false };
  }

  try {
    await response.body?.cancel?.();
  } catch {
    // A failed cleanup must not prevent the bounded retry.
  }
  response = await request(refreshed);
  return { response, apiKey: refreshed, refreshed: true };
}

/** Relay an Anthropic /v1/messages response (JSON or SSE) to the client. */
export interface RelayAnthropicOptions {
  authType?: 'api' | 'oauth' | 'none';
  /** Positive provenance for a non-default Anthropic upstream auth envelope. */
  anthropicAuthMode?: AnthropicAuthMode;
  log?: (message: string) => void;
  /**
   * The provider's configured static headers. Explicit operator authority, and
   * the only channel through which an arbitrary `Anthropic-Beta` can reach an
   * upstream. There is deliberately no session-identity option.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Route facts for capability-beta admission on an Anthropic-protocol route.
   *
   * "Anthropic-protocol" names the wire format, not the host: a third-party
   * provider clodex forwards to over the Anthropic Messages/count_tokens
   * endpoints is included on purpose, because those routes serve the same
   * beta-gated request shapes.
   *
   * Supplying this does NOT allow anything: it hands the policy the inbound
   * tokens and the route's own advertised id/window so the boundary can decide.
   * The destination URL and the exact forwarded body are taken from what this
   * relay is actually sending, not from the caller, and the whole set is
   * recomputed on every attempt including the OAuth-refresh retry. Omit it on a
   * translated route — one this relay sends in another wire format — to keep
   * the configured-only behaviour.
   */
  capability?: AnthropicCapabilityRouteFacts;
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>;
  onTokenRefreshed?: (token: string) => void;
  onUpstreamError?: (statusCode: number, body: string) => void;
  signal?: AbortSignal;
  /**
   * Echo this exact model id in the relayed response instead of the upstream's.
   * Claude Code resolves context windows from the response `model` field but
   * uses the request id for preflight, so a passthrough route selected through
   * an alias must echo the alias or auto-compaction misses its window config
   * (see CLAUDE.md "alias response-model echo"). Rewrites the JSON body's
   * `model` and the SSE `message_start` event; every other byte passes through.
   */
  responseModelOverride?: string;
}

/**
 * Response metadata a direct launch would have received from the upstream, and
 * which the relay must not swallow.
 *
 * Two kinds only: the request/rate-limit identifiers a client needs to reason
 * about throttling and to quote back in a support request, and — on a 429 — a
 * bounded backoff hint. Nothing else is copied, so credential/session-bearing
 * response headers (`set-cookie`, auth echoes) never cross the boundary.
 *
 * The retry hint is CLAMPED rather than forwarded: an upstream is free to name
 * a multi-hour delay, and relaying that verbatim parks a Claude Code session
 * well past clodex's own stream budget. `clampRetryAfterSeconds` bounds it to
 * [0, 60]s and substitutes the 5s default for a missing or non-numeric value,
 * so a throttled client always gets an actionable, finite hint.
 *
 * Response ids are FORWARDED, never retained: nothing here logs or persists
 * them.
 */
function anthropicRelayResponseHeaders(
  upstreamRes: Response,
  fallbackContentType: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': upstreamRes.headers.get('content-type') || fallbackContentType,
  };
  upstreamRes.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === 'request-id'
      || lower === 'x-request-id'
      || /^anthropic-ratelimit-[a-z0-9-]+$/.test(lower)
      || /^x-ratelimit-[a-z0-9-]+$/.test(lower)
    ) {
      headers[lower] = value;
    }
  });
  if (upstreamRes.status === 429) {
    const raw = upstreamRes.headers.get('retry-after')?.trim();
    const numeric = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : undefined;
    headers['retry-after'] = String(clampRetryAfterSeconds(numeric));
  }
  return headers;
}

/**
 * An event-stream line ends with CRLF, LF, or a bare CR. Splitting on \n alone
 * finds no boundary at all in a CR-framed stream: every byte accumulates in the
 * tail buffer and the client sees nothing until the upstream closes, which
 * stalls the relay rather than merely missing a rewrite. Capturing the
 * separator lets each line be re-emitted with the exact ending it arrived with.
 */
const SSE_LINE_SPLIT = /(\r\n|\r|\n)/;

/**
 * Line-preserving SSE transform that rewrites the `message_start` event's
 * `message.model` to the requested id. Buffers only up to one line; every
 * line that is not a parseable `message_start` data line passes through
 * byte-for-byte, with its original line ending.
 */
export function anthropicSseModelRewrite(override: string): Transform {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:') || !line.includes('"message_start"')) return line;
    try {
      // A multi-line `data:` payload (legal SSE, never emitted by Anthropic)
      // fails to parse here and relays untouched — fail-open, so the worst
      // case is an un-rewritten model id rather than a corrupted stream.
      const parsed = JSON.parse(line.slice(5)) as { type?: string; message?: { model?: unknown } };
      if (parsed.type === 'message_start' && parsed.message && typeof parsed.message.model === 'string') {
        parsed.message.model = override;
        return 'data: ' + JSON.stringify(parsed);
      }
    } catch {
      // Not a single-line JSON payload; relay it untouched.
    }
    return line;
  };
  // Split preserves separators at odd indices, so a line and its exact ending
  // are re-joined unchanged; the final element is the unterminated remainder.
  const rewriteTerminated = (parts: string[]): string => {
    let out = '';
    for (let i = 0; i + 1 < parts.length; i += 2) out += rewriteLine(parts[i]!) + parts[i + 1]!;
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffered = tail + decoder.write(chunk);
      // Emit every observed line ending immediately. If a CRLF is split across
      // chunks, the CR and later LF still pass through in their original order;
      // treating the LF as an empty internal line is harmless because this
      // transform carries no event-level state.
      const parts = buffered.split(SSE_LINE_SPLIT);
      tail = parts.pop() ?? '';
      callback(null, rewriteTerminated(parts));
    },
    flush(callback) {
      const rest = tail + decoder.end();
      if (!rest) {
        callback(null, '');
        return;
      }
      const parts = rest.split(SSE_LINE_SPLIT);
      const remainder = parts.length % 2 === 1 ? parts.pop()! : '';
      callback(null, rewriteTerminated(parts) + (remainder ? rewriteLine(remainder) : ''));
    },
  });
}

export async function relayAnthropicMessages(
  res: ServerResponse,
  messagesUrl: string,
  body: Record<string, unknown>,
  apiKey: string,
  clientWantsStream: boolean,
  options: RelayAnthropicOptions = {},
): Promise<void> {
  const doFetch = (key: string) => fetchWithoutRedirects(messagesUrl, {
    method: 'POST',
    headers: anthropicUpstreamHeaders(
      key,
      clientWantsStream,
      options.authType,
      options.extraHeaders,
      options.capability
        ? { ...options.capability, url: messagesUrl, body }
        : undefined,
      options.anthropicAuthMode,
    ),
    body: JSON.stringify(body),
    signal: options.signal,
  });

  let upstreamRes: Response;
  try {
    const retryResult = await fetchWithOAuthRetry(apiKey, doFetch, options.refreshToken);
    upstreamRes = retryResult.response;
    if (retryResult.refreshed) options.onTokenRefreshed?.(retryResult.apiKey);
  } catch (err) {
    throw new UpstreamUnreachableError(err);
  }

  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text();
    options.log?.(`anthropic upstream ${upstreamRes.status}: ${errBody}`);
    options.onUpstreamError?.(upstreamRes.status, errBody);
    res.writeHead(
      upstreamRes.status,
      anthropicRelayResponseHeaders(upstreamRes, 'application/json'),
    );
    res.end(errBody);
    return;
  }

  if (clientWantsStream && upstreamRes.body) {
    res.writeHead(200, {
      ...anthropicRelayResponseHeaders(upstreamRes, 'text/event-stream'),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const upstream = Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', () => res.destroy());
    if (options.responseModelOverride) {
      upstream
        .pipe(anthropicSseModelRewrite(options.responseModelOverride))
        .on('error', () => res.destroy())
        .pipe(res);
    } else {
      upstream.pipe(res);
    }
    return;
  }

  if (!upstreamRes.body) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream returned empty response body' } }));
    return;
  }

  let text = await upstreamRes.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream response was not valid JSON' } }));
    return;
  }
  // Narrowed to an Anthropic Message, matching what the SSE path already
  // requires of `message_start`. Any JSON object with a string `model` used to
  // qualify, so an error envelope or a count_tokens-shaped body that happened
  // to carry one had its `model` rewritten too — the two directions of the same
  // relay disagreed about what they were allowed to touch.
  if (
    options.responseModelOverride
    && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).type === 'message'
    && typeof (parsed as Record<string, unknown>).model === 'string'
  ) {
    (parsed as Record<string, unknown>).model = options.responseModelOverride;
    text = JSON.stringify(parsed);
  }
  res.writeHead(200, {
    ...anthropicRelayResponseHeaders(upstreamRes, 'application/json'),
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}
