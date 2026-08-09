import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'tsup';

interface WrapperResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface LaunchEnv {
  baseUrl: string | null;
  httpProxy: string | null;
  sessionProxy: string | null;
  fable: string | null;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let buildRoot: string;
let wrapperPath: string;
let testRoot: string;
let clodexHome: string;
let helperPath: string;
let launchMarker: string;

async function openLoopbackServer(
  host = '127.0.0.1',
  ipv6Only = false,
): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host, ipv6Only }, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('expected a TCP listener');
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
}

function advertiseEndpoint(port: number): void {
  mkdirSync(clodexHome, { recursive: true });
  writeFileSync(join(clodexHome, 'server-runtime.json'), `${JSON.stringify([{
    mode: 'endpoint',
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }])}\n`);
}

function sessionEnv(port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const proxy = `http://127.0.0.1:${port}`;
  return {
    CLODEX_SESSION_PROXY: `${port}:${process.pid}`,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'wjudge',
    CLODEX_INJECTED_BUILTINS: 'fable=wjudge',
    ...extra,
  };
}

async function runWrapper(
  args: string[],
  envOverrides: NodeJS.ProcessEnv,
): Promise<WrapperResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLODEX_HOME: clodexHome,
    ...envOverrides,
  };
  if (!Object.hasOwn(envOverrides, 'CLODEX_REQUIRE_SERVER')) {
    delete env['CLODEX_REQUIRE_SERVER'];
  }
  if (!Object.hasOwn(envOverrides, 'CLODEX_OAUTH_ACCOUNT')) {
    delete env['CLODEX_OAUTH_ACCOUNT'];
  }
  for (const name of Object.keys(env)) {
    if (/^CLODEX_KEY_[A-Z0-9_]+$/.test(name) && !Object.hasOwn(envOverrides, name)) {
      delete env[name];
    }
  }
  // Keep assertions independent of whatever Anthropic endpoint the test host
  // may have configured; the wrapper under test is responsible for adding one.
  delete env['ANTHROPIC_BASE_URL'];
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('wrapper timed out'));
    }, 5_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

function claudeInvocation(): string[] {
  return [process.execPath, helperPath, launchMarker];
}

function readLaunchEnv(): LaunchEnv {
  return JSON.parse(readFileSync(launchMarker, 'utf8')) as LaunchEnv;
}

beforeAll(async () => {
  buildRoot = mkdtempSync(join(tmpdir(), 'clodex-session-wrapper-build-'));
  await build({
    entry: [join(projectRoot, 'src', 'claude-wrapper.ts')],
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    outDir: buildRoot,
    outExtension: () => ({ js: '.mjs' }),
    clean: true,
    dts: false,
    minify: false,
    silent: true,
    sourcemap: false,
    splitting: false,
  });
  wrapperPath = join(buildRoot, 'claude-wrapper.mjs');
  expect(existsSync(wrapperPath)).toBe(true);
});

afterAll(() => {
  rmSync(buildRoot, { recursive: true, force: true });
});

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'clodex-session-wrapper-test-'));
  clodexHome = join(testRoot, 'clodex-home');
  helperPath = join(testRoot, 'fake-claude.mjs');
  launchMarker = join(testRoot, 'launch.json');
  writeFileSync(helperPath, [
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.argv[2], JSON.stringify({',
    '  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,',
    '  httpProxy: process.env.HTTP_PROXY ?? null,',
    '  sessionProxy: process.env.CLODEX_SESSION_PROXY ?? null,',
    '  fable: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? null,',
    '}));',
    '',
  ].join('\n'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('clodex-claude inherited session routing', () => {
  it('prefers the live inherited session over an advertised standalone server', async () => {
    const session = await openLoopbackServer();
    const standalone = await openLoopbackServer();
    advertiseEndpoint(standalone.port);
    try {
      const result = await runWrapper(claudeInvocation(), sessionEnv(session.port));
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(readLaunchEnv()).toEqual({
        baseUrl: null,
        httpProxy: `http://127.0.0.1:${session.port}`,
        sessionProxy: `${session.port}:${process.pid}`,
        fable: 'wjudge',
      });
    } finally {
      await Promise.all([closeServer(session.server), closeServer(standalone.server)]);
    }
  });

  it('keeps a provider key inside the live private session that owns its route snapshot', async () => {
    const session = await openLoopbackServer();
    const standalone = await openLoopbackServer();
    advertiseEndpoint(standalone.port);
    try {
      const result = await runWrapper(
        claudeInvocation(),
        sessionEnv(session.port, { CLODEX_KEY_OPENAI_OAUTH: 'private-session-token' }),
      );
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stderr).not.toContain('cannot override the credential snapshot');
      expect(readLaunchEnv().httpProxy).toBe(`http://127.0.0.1:${session.port}`);
    } finally {
      await Promise.all([closeServer(session.server), closeServer(standalone.server)]);
    }
  });

  it('requires the marked session listener to answer before it can outrank a standalone server', async () => {
    // Hold this numeric port on IPv6 only so the wrapper's IPv4 probe gets a
    // deterministic refusal and the port cannot be reused during the test.
    const deadSession = await openLoopbackServer('::1', true);
    const standalone = await openLoopbackServer();
    advertiseEndpoint(standalone.port);
    try {
      const result = await runWrapper(claudeInvocation(), sessionEnv(deadSession.port));
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(readLaunchEnv()).toEqual({
        baseUrl: `http://127.0.0.1:${standalone.port}/anthropic`,
        httpProxy: null,
        sessionProxy: null,
        fable: null,
      });
    } finally {
      await Promise.all([closeServer(deadSession.server), closeServer(standalone.server)]);
    }
  });

  it('rejects a provider key when a dead private session falls back to a standalone server', async () => {
    const deadSession = await openLoopbackServer('::1', true);
    const standalone = await openLoopbackServer();
    advertiseEndpoint(standalone.port);
    try {
      const result = await runWrapper(
        claudeInvocation(),
        sessionEnv(deadSession.port, { CLODEX_KEY_OPENAI_OAUTH: 'fallback-token' }),
      );
      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain('CLODEX_KEY_OPENAI_OAUTH cannot override the credential snapshot');
      expect(result.stderr).not.toContain('fallback-token');
      expect(existsSync(launchMarker)).toBe(false);
    } finally {
      await Promise.all([closeServer(deadSession.server), closeServer(standalone.server)]);
    }
  });

  it('keeps --check scoped to advertised servers while a live session satisfies fail-closed launch', async () => {
    const session = await openLoopbackServer();
    try {
      expect((await runWrapper(['--check'], sessionEnv(session.port))).code).toBe(1);
      const result = await runWrapper(
        claudeInvocation(),
        sessionEnv(session.port, { CLODEX_REQUIRE_SERVER: '1' }),
      );
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(readLaunchEnv().httpProxy).toBe(`http://127.0.0.1:${session.port}`);
    } finally {
      await closeServer(session.server);
    }
  });
});
