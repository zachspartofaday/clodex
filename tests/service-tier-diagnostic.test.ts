import { afterEach, describe, expect, it } from 'vitest';
import { isOpenAiOAuthRoute, oauthServiceTier, translateRequest } from '../src/sdk-adapter.js';

/**
 * The diagnostic exists to answer one question — "did `--fast` actually put a
 * service tier on the wire?" — which previously could only be answered by
 * reading source. A log that answers it WRONGLY is worse than no log, so these
 * tests pin the reported value against what the adapter actually sends rather
 * than against a restatement of the rule.
 */
const OAUTH_ROUTE = { npm: '@ai-sdk/openai', authType: 'oauth' };

function withTier<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.CLODEX_SERVICE_TIER;
  if (value === undefined) delete process.env.CLODEX_SERVICE_TIER;
  else process.env.CLODEX_SERVICE_TIER = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CLODEX_SERVICE_TIER;
    else process.env.CLODEX_SERVICE_TIER = previous;
  }
}

/** What the adapter puts on the wire for an OAuth route, or undefined. */
function tierOnTheWire(): unknown {
  const params = translateRequest(
    { model: 'gpt-5.6-sol', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } as never,
    '@ai-sdk/openai',
    { openAiOAuth: true } as never,
  ) as { providerOptions?: Record<string, Record<string, unknown>> };
  const openai = params.providerOptions?.openai ?? {};
  return openai.serviceTier;
}

/** What the diagnostic would record for that same request. */
function tierInTheLog(route: { npm?: string; authType?: string } | undefined): string | undefined {
  return isOpenAiOAuthRoute(route) ? oauthServiceTier() : undefined;
}

describe('service tier diagnostic', () => {
  afterEach(() => {
    delete process.env.CLODEX_SERVICE_TIER;
  });

  it('records exactly what the adapter sends, for every accepted spelling', () => {
    // The property that matters. Reported and applied are computed by the same
    // resolver, so a future change to one cannot silently desync the other.
    for (const configured of [undefined, 'fast', 'priority', 'flex', 'auto', 'default']) {
      withTier(configured, () => {
        expect(tierInTheLog(OAUTH_ROUTE), `CLODEX_SERVICE_TIER=${configured}`).toBe(tierOnTheWire());
      });
    }
  });

  it('normalises the Codex spelling, so the log shows the wire value', () => {
    // `fast` is the Codex CLI's word; `priority` is what goes on the wire.
    // Logging the input would answer the question with the wrong vocabulary.
    withTier('fast', () => {
      expect(tierInTheLog(OAUTH_ROUTE)).toBe('priority');
      expect(tierOnTheWire()).toBe('priority');
    });
  });

  it('reports nothing when no tier is configured', () => {
    // Absence in the log is meaningful: it means no tier was sent, which is the
    // backend default rather than an omission by the logger.
    withTier(undefined, () => {
      expect(tierInTheLog(OAUTH_ROUTE)).toBeUndefined();
      expect(tierOnTheWire()).toBeUndefined();
    });
  });

  it('reports nothing on a route that cannot carry a tier', () => {
    // The tier is OAuth-only: API-key OpenAI is excluded because `priority`
    // there is a billable surcharge, and other providers never see it. A log
    // claiming a tier on those routes would be inventing one.
    withTier('fast', () => {
      expect(tierInTheLog({ npm: '@ai-sdk/openai', authType: 'api' })).toBeUndefined();
      expect(tierInTheLog({ npm: '@ai-sdk/openai-compatible', authType: 'oauth' })).toBeUndefined();
      expect(tierInTheLog({ npm: '@ai-sdk/anthropic', authType: 'api' })).toBeUndefined();
      expect(tierInTheLog(undefined)).toBeUndefined();
    });
  });

  it('reports nothing for a value the resolver refuses', () => {
    withTier('turbo', () => {
      expect(tierInTheLog(OAUTH_ROUTE)).toBeUndefined();
      expect(tierOnTheWire()).toBeUndefined();
    });
  });
});
