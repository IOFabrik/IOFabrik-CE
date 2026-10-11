import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../bindings/iofabrik/services/gitservice', () => ({
  GetFileAtRevisionBase64: vi.fn(),
  ReadFileAtRevisionLarge: vi.fn(),
}));

vi.mock('../../../../bindings/iofabrik/services/filesystemservice', () => ({
  ReadFileBase64: vi.fn(),
  ReadTextFile: vi.fn(),
}));

import { GetFileAtRevisionBase64, ReadFileAtRevisionLarge } from '../../../../bindings/iofabrik/services/gitservice';
import { ReadFileBase64, ReadTextFile } from '../../../../bindings/iofabrik/services/filesystemservice';
import {
  loadBinarySide,
  loadTextSide,
  serializeDiffSide,
} from './diff-side-loaders';

describe('diff-side-loaders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads ref text content through the git service', async () => {
    vi.mocked(ReadFileAtRevisionLarge).mockResolvedValue({
      hasError: false,
      content: '<L5X />',
    });

    await expect(
      loadTextSide('/repo', { kind: 'ref', ref: 'origin/main', path: 'Programs/Main.L5X' }),
    ).resolves.toBe('<L5X />');

    expect(ReadFileAtRevisionLarge).toHaveBeenCalledWith('/repo', 'Programs/Main.L5X', 'origin/main');
  });

  it('treats missing working-tree text files as absent sides', async () => {
    vi.mocked(ReadTextFile).mockResolvedValue({
      success: false,
      error: 'file does not exist',
    });

    await expect(
      loadTextSide('/repo', {
        kind: 'working',
        absolutePath: '/repo/Programs/Missing.L5X',
        path: 'Programs/Missing.L5X',
      }),
    ).resolves.toBeNull();
  });

  it('loads working-tree binary content through the filesystem service', async () => {
    vi.mocked(ReadFileBase64).mockResolvedValue({
      success: true,
      data: 'ZmFrZQ==',
      mimeType: 'application/pdf',
      size: 4,
    });

    await expect(
      loadBinarySide('/repo', {
        kind: 'working',
        absolutePath: '/repo/Docs/Manual.pdf',
        path: 'Docs/Manual.pdf',
      }),
    ).resolves.toEqual({
      base64Data: 'ZmFrZQ==',
      mimeType: 'application/pdf',
      size: 4,
    });

    expect(ReadFileBase64).toHaveBeenCalledWith('/repo/Docs/Manual.pdf');
  });

  it('throws a clear error when a binary ref load fails', async () => {
    vi.mocked(GetFileAtRevisionBase64).mockResolvedValue({
      success: false,
      error: 'git cat-file failed',
    });

    await expect(
      loadBinarySide('/repo', { kind: 'ref', ref: 'origin/main', path: 'Docs/Manual.pdf' }),
    ).rejects.toThrow('Failed to load origin/main:Docs/Manual.pdf: git cat-file failed');
  });

  it('serializes working sides with their absolute path for cache keys', () => {
    expect(
      serializeDiffSide({
        kind: 'working',
        absolutePath: '/repo/Docs/Manual.pdf',
        path: 'Docs/Manual.pdf',
      }),
    ).toBe('working:/repo/Docs/Manual.pdf:Docs/Manual.pdf');
  });
});