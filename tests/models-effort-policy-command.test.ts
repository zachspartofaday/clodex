import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as p from '@clack/prompts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelsCommand } from '../src/cli.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { getConfigPath } from '../src/paths.js';

const selectMock = vi.hoisted(() => vi.fn());
const spinnerStartMock = vi.hoisted(() => vi.fn());
const spinnerStopMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    select: selectMock,
    isCancel: (value: unknown) => typeof value === 'symbol',
    spinner: () => ({
      start: spinnerStartMock,
      stop: spinnerStopMock,
    }),
  };
});

// The manager's provider-bearing path is what the policy entry lives on, so the
// catalog is stubbed with exactly one provider rather than left empty.
vi.mock('../src/provider-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-catalog.js')>(),
  fetchProviderCatalog: vi.fn(async () => []),
  providersForPicker: vi.fn(() => [{
    id: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    apiKey: 'token',
    models: [{
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      family: 'gpt',
      brand: 'GPT',
      modelFormat: 'openai',
      upstreamModelId: 'gpt-5.6-luna',
      npm: '@ai-sdk/openai',
    }],
  }]),
}));

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-effort-policy-command-'));
  process.env['CLODEX_HOME'] = tempHome;
  selectMock.mockReset();
  spinnerStartMock.mockReset();
  spinnerStopMock.mockReset();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CLODEX_HOME'];
  vi.restoreAllMocks();
});

describe('models effort-policy selector', () => {
  it('shows the current policy in the manager and changes it', async () => {
    const success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
    vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    selectMock
      .mockResolvedValueOnce('__effort_policy__')
      .mockResolvedValueOnce('up')
      .mockResolvedValueOnce('__done__');

    expect(await runModelsCommand()).toBe(0);

    const managerPrompt = selectMock.mock.calls[0]?.[0];
    expect(managerPrompt.options).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: '__effort_policy__',
        label: 'Unsupported effort policy: Provider default',
      }),
    ]));
    const policyPrompt = selectMock.mock.calls[1]?.[0];
    expect(policyPrompt).toMatchObject({
      message: 'Unsupported worker effort policy',
      initialValue: 'provider-default',
      options: [
        expect.objectContaining({ value: 'provider-default', label: 'Provider default' }),
        expect.objectContaining({ value: 'up', label: 'Round up' }),
        expect.objectContaining({ value: 'down', label: 'Round down' }),
        expect.objectContaining({ value: 'exact', label: 'Exact only' }),
      ],
    });
    expect(loadPreferences().effortPolicy).toBe('up');
    expect(success).toHaveBeenCalledWith('Global unsupported-effort policy changed to Round up.');
    expect(info).toHaveBeenCalledWith(
      'Running clodex processes keep their startup policy snapshot; restart them to apply this change.',
    );
    // The manager is re-rendered with the new value, not the stale one.
    expect(selectMock.mock.calls[2]?.[0].options).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: '__effort_policy__',
        label: 'Unsupported effort policy: Round up',
      }),
    ]));
  });

  it('does not write or show a restart notice when the selector is cancelled', async () => {
    savePreferences({ effortPolicy: 'exact' });
    const before = readFileSync(getConfigPath(), 'utf8');
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
    const success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
    vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    selectMock
      .mockResolvedValueOnce('__effort_policy__')
      .mockResolvedValueOnce(Symbol('cancel'))
      .mockResolvedValueOnce('__done__');

    expect(await runModelsCommand()).toBe(0);

    expect(readFileSync(getConfigPath(), 'utf8')).toBe(before);
    expect(loadPreferences().effortPolicy).toBe('exact');
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalledWith(
      'Running clodex processes keep their startup policy snapshot; restart them to apply this change.',
    );
  });

  it('does not rewrite config when the selected policy is unchanged', async () => {
    savePreferences({ effortPolicy: 'down' });
    const before = readFileSync(getConfigPath(), 'utf8');
    const success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
    vi.spyOn(p.log, 'info').mockImplementation(() => {});
    vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    selectMock
      .mockResolvedValueOnce('__effort_policy__')
      .mockResolvedValueOnce('down')
      .mockResolvedValueOnce('__done__');

    expect(await runModelsCommand()).toBe(0);

    expect(readFileSync(getConfigPath(), 'utf8')).toBe(before);
    expect(success).not.toHaveBeenCalled();
  });
});
