import { GetFileAtRevisionBase64, ReadFileAtRevisionLarge } from '../../../../bindings/iofabrik/services/gitservice';
import { ReadFileBase64, ReadTextFile } from '../../../../bindings/iofabrik/services/filesystemservice';
import type { DiffSide } from '../../registry/diff-registry';

export interface BinarySidePayload {
  base64Data: string;
  mimeType?: string;
  size?: number;
}

function isMissingFileError(error?: string): boolean {
  if (!error) {
    return false;
  }

  return /(does not exist|not exist|no such file|cannot find|not found|missing)/i.test(error);
}

function formatSideLabel(side: DiffSide): string {
  switch (side.kind) {
    case 'ref':
      return `${side.ref}:${side.path}`;
    case 'working':
      return side.absolutePath;
    case 'missing':
      return side.path;
    default:
      return side satisfies never;
  }
}

export function serializeDiffSide(side?: DiffSide): string {
  if (!side) {
    return 'none';
  }

  switch (side.kind) {
    case 'ref':
      return `ref:${side.ref}:${side.path}`;
    case 'working':
      return `working:${side.absolutePath}:${side.path}`;
    case 'missing':
      return `missing:${side.path}`;
    default:
      return side satisfies never;
  }
}

export async function loadTextSide(repoPath: string, side: DiffSide): Promise<string | null> {
  if (side.kind === 'missing') {
    return null;
  }

  if (side.kind === 'ref') {
    const result = await ReadFileAtRevisionLarge(repoPath, side.path, side.ref);
    if (result.hasError) {
      if (isMissingFileError(result.error)) {
        return null;
      }
      throw new Error(`Failed to load ${formatSideLabel(side)}: ${result.error || 'Unknown error'}`);
    }
    return result.content;
  }

  const result = await ReadTextFile(side.absolutePath);
  if (!result.success) {
    if (isMissingFileError(result.error)) {
      return null;
    }
    throw new Error(`Failed to load ${formatSideLabel(side)}: ${result.error || 'Unknown error'}`);
  }

  return result.content ?? '';
}

export async function loadBinarySide(repoPath: string, side: DiffSide): Promise<BinarySidePayload | null> {
  if (side.kind === 'missing') {
    return null;
  }

  if (side.kind === 'ref') {
    const result = await GetFileAtRevisionBase64(repoPath, side.path, side.ref);
    if (!result.success) {
      if (isMissingFileError(result.error)) {
        return null;
      }
      throw new Error(`Failed to load ${formatSideLabel(side)}: ${result.error || 'Unknown error'}`);
    }

    if (!result.data) {
      throw new Error(`Failed to load ${formatSideLabel(side)}: empty binary payload`);
    }

    return {
      base64Data: result.data,
      mimeType: result.mimeType,
      size: result.size,
    };
  }

  const result = await ReadFileBase64(side.absolutePath);
  if (!result.success) {
    if (isMissingFileError(result.error)) {
      return null;
    }
    throw new Error(`Failed to load ${formatSideLabel(side)}: ${result.error || 'Unknown error'}`);
  }

  if (!result.data) {
    throw new Error(`Failed to load ${formatSideLabel(side)}: empty binary payload`);
  }

  return {
    base64Data: result.data,
    mimeType: result.mimeType,
    size: result.size,
  };
}