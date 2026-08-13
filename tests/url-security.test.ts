import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canonicalAnthropicBaseUrl,
  canonicalOpenAiBaseUrl,
  validateCustomEndpointUrl,
} from '../src/registry/url-security.js';

describe('validateCustomEndpointUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts public https URLs', async () => {
    const result = await validateCustomEndpointUrl('https://api.groq.com/openai/v1');
    expect(result.ok).toBe(true);
    expect(result.normalizedUrl).toContain('api.groq.com');
  });

  it('blocks cloud metadata hostnames', async () => {
    const result = await validateCustomEndpointUrl('https://metadata.google.internal/computeMetadata/v1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/i);
  });

  it('blocks plain http without local allowance', async () => {
    const result = await validateCustomEndpointUrl('http://127.0.0.1:11434/v1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTPS/i);
  });

  it('allows localhost http when allowInsecureLocal is set', async () => {
    const result = await validateCustomEndpointUrl('http://127.0.0.1:11434/v1', { allowInsecureLocal: true });
    expect(result.ok).toBe(true);
  });

  it('allows private LAN http when insecure local access is explicitly approved', async () => {
    const result = await validateCustomEndpointUrl('http://192.168.68.5:11434/v1', { allowInsecureLocal: true });
    expect(result.ok).toBe(true);
    expect(result.normalizedUrl).toBe('http://192.168.68.5:11434/v1');
  });

  it('blocks private LAN http without explicit insecure approval', async () => {
    const result = await validateCustomEndpointUrl('http://192.168.68.5:11434/v1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTPS/i);
  });

  it('blocks AWS metadata IP', async () => {
    const result = await validateCustomEndpointUrl('https://169.254.169.254/latest/meta-data');
    expect(result.ok).toBe(false);
  });

  it('still blocks metadata IPs even when insecure local access is approved', async () => {
    const result = await validateCustomEndpointUrl('http://169.254.169.254/latest/meta-data', { allowInsecureLocal: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked|restricted/i);
  });
});

/*
 * This guards the moment a stored base URL becomes a live credential
 * destination, which is a different question from the SSRF guard above: that
 * one asks whether a HOST may be reached, this one asks whether the URL is
 * exactly the address it claims to be. Every rejection below is a way to make
 * a request go somewhere other than where the visible host suggests.
 */
describe('canonicalOpenAiBaseUrl', () => {
  it('canonicalizes ordinary base URLs', () => {
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(canonicalOpenAiBaseUrl('  https://api.openai.com/v1  ')).toBe('https://api.openai.com/v1');
    // One terminal separator is trimmed; a bare root collapses to an empty path.
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/')).toBe('https://api.openai.com');
    // Host case and default port are normalized by URL parsing.
    expect(canonicalOpenAiBaseUrl('https://API.OpenAI.com:443/v1')).toBe('https://api.openai.com/v1');
  });

  it('rejects query and fragment delimiters', () => {
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1?x=1')).toBeNull();
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1#frag')).toBeNull();
    // Rejected on the raw string, so a delimiter anywhere counts - not just one
    // the URL parser would classify as a query or fragment.
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1/a?b#c')).toBeNull();
  });

  it('keeps percent-encoded delimiters as ordinary path data', () => {
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1%3Fx')).toBe('https://api.openai.com/v1%3Fx');
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1%23x')).toBe('https://api.openai.com/v1%23x');
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1%40x')).toBe('https://api.openai.com/v1%40x');
  });

  it('rejects non-http(s) protocols', () => {
    expect(canonicalOpenAiBaseUrl('ftp://api.openai.com/v1')).toBeNull();
    expect(canonicalOpenAiBaseUrl('file:///etc/passwd')).toBeNull();
    expect(canonicalOpenAiBaseUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalOpenAiBaseUrl('not a url')).toBeNull();
  });

  it('rejects embedded userinfo, including the empty forms URL parsing erases', () => {
    expect(canonicalOpenAiBaseUrl('https://user:pass@evil.example/v1')).toBeNull();
    expect(canonicalOpenAiBaseUrl('https://user@evil.example/v1')).toBeNull();
    // `new URL` drops these silently, leaving a hostname that looks clean, so the
    // raw authority is inspected as well.
    expect(canonicalOpenAiBaseUrl('https://@evil.example/v1')).toBeNull();
    expect(canonicalOpenAiBaseUrl('https://:@evil.example/v1')).toBeNull();
  });

  it('rejects two or more terminal separators', () => {
    expect(canonicalOpenAiBaseUrl('https://api.openai.com/v1//')).toBeNull();
  });
});

describe('canonicalAnthropicBaseUrl', () => {
  it('preserves legitimate HTTPS custom paths and removes the SDK-owned v1 suffix', () => {
    expect(canonicalAnthropicBaseUrl('https://gateway.example/anthropic')).toBe(
      'https://gateway.example/anthropic',
    );
    expect(canonicalAnthropicBaseUrl('  https://GATEWAY.example:443/anthropic/v1/  ')).toBe(
      'https://gateway.example/anthropic',
    );
    expect(canonicalAnthropicBaseUrl('https://gateway.example/')).toBe('https://gateway.example');
  });

  it('rejects every non-HTTPS or ambiguous authority form', () => {
    for (const raw of [
      'http://gateway.example/v1',
      'ftp://gateway.example/v1',
      'https:/gateway.example/v1',
      'https:gateway.example/v1',
      'https:\\\\gateway.example/v1',
      'https:////gateway.example/v1',
      'not a url',
    ]) {
      expect(canonicalAnthropicBaseUrl(raw), raw).toBeNull();
    }
  });

  it('rejects query, fragment, and every userinfo spelling', () => {
    for (const raw of [
      'https://gateway.example/v1?next=evil',
      'https://gateway.example/v1#evil',
      'https://user@gateway.example/v1',
      'https://user:pass@gateway.example/v1',
      'https://:pass@gateway.example/v1',
      'https://user:@gateway.example/v1',
      'https://@gateway.example/v1',
      'https://:@gateway.example/v1',
    ]) {
      expect(canonicalAnthropicBaseUrl(raw), raw).toBeNull();
    }
  });

  it('keeps percent-encoded delimiters as pathname data', () => {
    expect(canonicalAnthropicBaseUrl('https://gateway.example/v1%3Fx')).toBe(
      'https://gateway.example/v1%3Fx',
    );
    expect(canonicalAnthropicBaseUrl('https://gateway.example/v1%23x')).toBe(
      'https://gateway.example/v1%23x',
    );
    expect(canonicalAnthropicBaseUrl('https://gateway.example/v1%40x')).toBe(
      'https://gateway.example/v1%40x',
    );
  });
});
