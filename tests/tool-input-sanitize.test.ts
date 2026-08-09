import { describe, expect, it } from 'vitest';
import { sanitizeToolInput } from '../src/tool-input-sanitize.js';

describe('sanitizeToolInput', () => {
  it.each(['', ' ', '0', '1', '1-3'])(
    'strips Read.pages=%j from a non-PDF path',
    pages => {
      expect(sanitizeToolInput(
        { file_path: '/repo/file.swift', offset: 1, pages },
        new Set(['file_path']),
        'Read',
      )).toEqual({ file_path: '/repo/file.swift', offset: 1 });
    },
  );

  it('preserves a PDF page range case-insensitively', () => {
    expect(sanitizeToolInput(
      { file_path: '/repo/FILE.PDF', pages: '1-3' },
      new Set(['file_path']),
      'Read',
    )).toEqual({ file_path: '/repo/FILE.PDF', pages: '1-3' });
  });

  it.each(['/repo/file', '/repo/.env', '/repo/file.', 'C:\\repo\\.env'])
    ('preserves pages when a Read path has no recognizable extension: %s', file_path => {
      expect(sanitizeToolInput(
        { file_path, pages: '1' },
        new Set(['file_path']),
        'Read',
      )).toEqual({ file_path, pages: '1' });
    });

  it('preserves pages when the tool or file type does not prove a non-PDF Read', () => {
    expect(sanitizeToolInput(
      { file_path: '/repo/file.swift', pages: '1' },
      new Set(['file_path']),
      'OtherTool',
    )).toEqual({ file_path: '/repo/file.swift', pages: '1' });
    expect(sanitizeToolInput(
      { pages: '1' },
      undefined,
      'Read',
    )).toEqual({ pages: '1' });
  });
});
