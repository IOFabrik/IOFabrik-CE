import { FILE_STATUS } from '../../../shared/constants';
import type { FileStatus } from '../context/RepoContext.types';
import { isTextViewerExtension } from '../../../viewers/components/file/text-viewer-patterns';
import type { TrackedPattern } from '../../../../bindings/iofabrik/services/models';

export interface LFSAutoTrackCandidate {
  filePath: string;
  fileName: string;
  extension: string;
  pattern: string;
}

function getExtension(filePath: string): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  if (fileName.startsWith('.') && !fileName.includes('.', 1)) {
    return '';
  }
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return ext;
}

function normalizePattern(rawPattern: string): string {
  return rawPattern.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function trackedExtensionsSet(patterns: TrackedPattern[]): Set<string> {
  const extensions = new Set<string>();

  for (const item of patterns) {
    const pattern = normalizePattern(item.pattern || '');
    const match = /^\*\.([a-z0-9]+)$/i.exec(pattern);
    if (match?.[1]) {
      extensions.add(match[1].toLowerCase());
    }
  }

  return extensions;
}

export function getLFSAutoTrackCandidates(
  changedFiles: FileStatus[],
  trackedPatterns: TrackedPattern[],
): LFSAutoTrackCandidate[] {
  const trackedExts = trackedExtensionsSet(trackedPatterns);
  const candidates: LFSAutoTrackCandidate[] = [];

  for (const file of changedFiles) {
    if (file.status !== FILE_STATUS.UNTRACKED && file.status !== FILE_STATUS.ADDED) {
      continue;
    }

    const extension = getExtension(file.path);
    if (!extension) {
      continue;
    }

    if (trackedExts.has(extension)) {
      continue;
    }

    if (isTextViewerExtension(extension)) {
      continue;
    }

    candidates.push({
      filePath: file.path,
      fileName: file.name,
      extension,
      pattern: `*.${extension}`,
    });
  }

  return candidates;
}
