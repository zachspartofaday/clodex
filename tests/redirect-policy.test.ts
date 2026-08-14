import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { ensureHttpProxyCertificates, type HttpProxyCertificates } from '../src/http-proxy/ca.js';
import { fetchWithoutRedirects, RedirectBlockedError } from '../src/redirect-policy.js';

interface TestServer {
  server: Server | HttpsServer;
  url: string;
  close: () => Promise<void>;
}

interface RecordedRequest {
  headers: IncomingMessage['headers'];
  body: string;
}

let tlsHome: string;
let certificates: HttpProxyCertificates;
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>;
let upstreamDispatcher: Agent;

beforeAll(() => {
  tlsHome = mkdtempSync(join(tmpdir(), 'clodex-redirect-policy-tls-'));
  const previousHome = process.env.CLODEX_HOME;
  process.env.CLODEX_HOME = tlsHome;
  try {
    certificates = ensureHttpProxyCertificates();
  } finally {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
  }

  previousDispatcher = getGlobalDispatcher();
  upstreamDispatcher = new Agent({
    connect: { ca: certificates.caCert, servername: 'api.anthropic.com' },
  });
  setGlobalDispatcher(upstreamDispatcher);
});

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await upstreamDispatcher.close();
  rmSync(tlsHome, { recursive: true, force: true });
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

async function listen(server: Server | HttpsServer, scheme: 'http' | 'https'): Promise<TestServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return {
    server,
    url: `${scheme}://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    }),
  };
}

async function startTarget(): Promise<TestServer & { requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    requests.push({ headers: req.headers, body: await readBody(req) });
    res.writeHead(200);
    res.end('target');
  });
  return { ...(await listen(server, 'http')), requests };
}

async function startRedirect(
  status: 307 | 308,
  location: string,
  secure = false,
): Promise<TestServer> {
  const handler = (_req: IncomingMessage, res: import('node:http').ServerResponse) => {
    res.writeHead(status, { Location: location });
    res.end();
  };
  const server = secure
    ? createHttpsServer({ cert: certificates.serverCert, key: certificates.serverKey }, handler)
    : createServer(handler);
  return listen(server, secure ? 'https' : 'http');
}

describe('fetchWithoutRedirects', () => {
  it.each([307, 308])('blocks a %s redirect before a credential-bearing target request', async status => {
    const target = await startTarget();
    const redirect = await startRedirect(status as 307 | 308, `${target.url}/leak`);
    const request = {
      method: 'POST',
      headers: { 'x-api-key': 'secret-key' },
      body: 'secret-body',
    };

    try {
      const followed = await fetch(redirect.url, request);
      expect(followed.status).toBe(200);
      expect(target.requests).toHaveLength(1);
      expect(target.requests[0]!.headers['x-api-key']).toBe('secret-key');
      expect(target.requests[0]!.body).toBe('secret-body');

      target.requests.length = 0;
      const error = await fetchWithoutRedirects(redirect.url, request).catch(caught => caught);
      expect(error).toBeInstanceOf(RedirectBlockedError);
      const errorText = String(error);
      expect(errorText).toBe(`RedirectBlockedError: Redirect blocked (${status})`);
      expect(errorText).not.toContain(redirect.url);
      expect(errorText).not.toContain(target.url);
      expect(errorText).not.toContain('Location');
      expect(target.requests).toHaveLength(0);
    } finally {
      await redirect.close();
      await target.close();
    }
  });

  it('does not downgrade an HTTPS credential-bearing request to HTTP', async () => {
    const target = await startTarget();
    const redirect = await startRedirect(308, `${target.url}/downgrade`, true);
    const request = {
      method: 'POST',
      headers: { 'x-api-key': 'secret-key' },
      body: 'secret-body',
    };

    try {
      const error = await fetchWithoutRedirects(redirect.url, request).catch(caught => caught);
      expect(error).toBeInstanceOf(RedirectBlockedError);
      expect(String(error)).toBe('RedirectBlockedError: Redirect blocked (308)');
      expect(String(error)).not.toContain(redirect.url);
      expect(String(error)).not.toContain(target.url);
      expect(String(error)).not.toContain('Location');
      expect(target.requests).toHaveLength(0);
    } finally {
      await redirect.close();
      await target.close();
    }
  });
});
