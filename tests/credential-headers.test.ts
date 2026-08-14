import { describe, expect, it } from 'vitest';
import { isCredentialBearingHeader } from '../src/credential-headers.js';

describe('isCredentialBearingHeader', () => {
  it.each([
    'Authorization',
    'Proxy-Authorization',
    'X-API-Key',
    'Cookie',
    'Set-Cookie',
    'X-Auth-Token',
    'X-Client-Secret',
    'X-Credential-Id',
    ' X-API-Key ',
    'X-Auth',
    'Authentication',
    'X-Auth-Key',
    'XApiKey',
  ])('identifies %s as credential-bearing', (name) => {
    expect(isCredentialBearingHeader(name)).toBe(true);
  });

  it.each([
    'Accept',
    'Content-Type',
    'User-Agent',
    'X-Plan',
    'X-Request-Id',
    'X-Auth-Tracking',
    'Authentication-Info',
  ])('preserves non-credential header %s', (name) => {
    expect(isCredentialBearingHeader(name)).toBe(false);
  });
});
