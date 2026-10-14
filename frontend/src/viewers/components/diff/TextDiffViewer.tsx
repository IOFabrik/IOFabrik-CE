/**
 * TextDiffViewer - Displays a unified text diff for a single file.
 *
 * Used in:
 * - History/Commit view (commit vs parent)
 * - Explorer diff tabs (working tree vs HEAD)
 *
 * This component owns diff loading (unless `fileDiff` is provided) and then
 * delegates rendering to the shared `DiffViewer` component.
 */
import { memo, useEffect, useMemo, useState, useCallback } from 'react';
import { AlertCircle, Loader2, RotateCcw } from 'lucide-react';

import { ICON_SIZES } from '../../../shared/constants';
import DiffViewer from '../../../features/explorer/components/DiffViewer';

import {
  DiffCommitFileRaw,
  DiffMergeReviewFileRaw,
  DiffWorkingRaw,
} from '../../../../bindings/iofabrik/services/gitservice';
import type { RawDiffResult } from '../../../../bindings/iofabrik/services/models';
import type { DiffSide, TextDiffSource } from '../../registry/diff-registry';

// ============================================================================
// Types
// ============================================================================

export type TextDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TextDiffViewerProps {
  textDiffSource?: TextDiffSource;
  reloadToken?: number;
  /** Absolute path to the git repository root. */
  repoPath: string;
  /** Repository-relative file path (preferred). */
  filePath: string;
  oldSide?: DiffSide;
  newSide?: DiffSide;

  /** Optional status override (e.g., from status list). */
  fileStatus?: string;
  /** Optional old path (for renamed files). */
  oldPath?: string;

  /** Optional preloaded diff (skips fetching). */
  fileDiff?: RawDiffResult | null;

  /** Whether to show the diff header (default: true). */
  showHeader?: boolean;
}

// ============================================================================
// Cache
// ============================================================================

const textDiffCache = new Map<string, RawDiffResult>();

function serializeSide(side?: DiffSide): string {
  if (!side) return 'none';
  switch (side.kind) {
    case 'ref':
      return `ref:${side.ref}:${side.path}`;
    case 'working':
      return `working:${side.absolutePath}:${side.path}`;
    case 'missing':
      return `missing:${side.path}`;
    default:
      return 'unknown';
  }
}

function cacheKey(repoPath: string, filePath: string, oldSide?: DiffSide, newSide?: DiffSide): string {
  return `textdiff::${repoPath}::${filePath}::${serializeSide(oldSide)}::${serializeSide(newSide)}`;
}

function normalizeStatus(status?: string): TextDiffStatus {
  const s = (status || '').toLowerCase();
  if (s === 'untracked') return 'added';
  if (s === 'added') return 'added';
  if (s === 'deleted') return 'deleted';
  if (s === 'renamed') return 'renamed';
  return 'modified';
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

interface RawDiffFetcher {
  description: string;
  load: () => Promise<RawDiffResult>;
}

function isRefSide(side?: DiffSide): side is Extract<DiffSide, { kind: 'ref' }> {
  return side?.kind === 'ref';
}

function isWorkingSide(side?: DiffSide): side is Extract<DiffSide, { kind: 'working' }> {
  return side?.kind === 'working';
}

function resolveRawDiffFetcher(
  repoPath: string,
  filePath: string,
  oldSide?: DiffSide,
  newSide?: DiffSide,
  source?: TextDiffSource,
): RawDiffFetcher | null {
  if (source?.kind === 'working') return { description: 'working tree diff', load: () => DiffWorkingRaw(repoPath, filePath) };
  if (source?.kind === 'commit') return { description: 'commit diff', load: () => DiffCommitFileRaw(repoPath, source.commit, filePath) };
  if (source?.kind === 'refs') return { description: 'ref diff', load: () => DiffMergeReviewFileRaw(repoPath, source.oldRef, source.newRef, filePath) };

  if (isRefSide(oldSide) && isWorkingSide(newSide) && oldSide.ref === 'HEAD' && newSide.path === filePath) {
    return {
      description: 'working tree diff',
      load: () => DiffWorkingRaw(repoPath, filePath) as Promise<RawDiffResult>,
    };
  }

  if (isRefSide(oldSide) && isRefSide(newSide)) {
    const expectedParentRef = `${newSide.ref}^`;
    const isCommitHistoryDiff =
      newSide.path === filePath
      && oldSide.ref === expectedParentRef;

    if (isCommitHistoryDiff) {
      return {
        description: 'commit diff',
        load: () => DiffCommitFileRaw(repoPath, newSide.ref, filePath) as Promise<RawDiffResult>,
      };
    }

    return {
      description: 'ref diff',
      load: () => DiffMergeReviewFileRaw(repoPath, oldSide.ref, newSide.ref, filePath) as Promise<RawDiffResult>,
    };
  }

  return null;
}

// ============================================================================
// Component
// ============================================================================

function TextDiffViewer({
  repoPath,
  filePath,
  oldSide,
  newSide,
  fileStatus,
  oldPath,
  fileDiff,
  showHeader = true,
  textDiffSource,
  reloadToken = 0,
}: TextDiffViewerProps): JSX.Element {
  const repoRelativePath = useMemo((): string => {
    if (!filePath) return '';

    const normalizedFilePath = normalizePathSeparators(filePath);
    const normalizedRepoPath = normalizePathSeparators(repoPath || '').replace(/\/+$/, '');

    // Some callers may pass an absolute path (e.g., explorer tabs store absoluteFilePath).
    // GitService diff APIs expect repo-relative paths.
    const prefix = normalizedRepoPath ? `${normalizedRepoPath}/` : '';
    if (prefix && normalizedFilePath.startsWith(prefix)) {
      return normalizedFilePath.slice(prefix.length);
    }
    return normalizedFilePath;
  }, [repoPath, filePath]);

  const [diff, setDiff] = useState<RawDiffResult | null>(fileDiff ?? null);
  const [isLoading, setIsLoading] = useState<boolean>(!fileDiff);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const fetcher = useMemo(
    () => resolveRawDiffFetcher(repoPath, repoRelativePath, oldSide, newSide, textDiffSource),
    [repoPath, repoRelativePath, oldSide, newSide, textDiffSource],
  );

  const applyOverrides = useCallback((incoming: RawDiffResult): RawDiffResult => {
    const status = normalizeStatus(fileStatus || (incoming as any).status);
    const path = repoRelativePath || (incoming as any).path;

    // The bindings type should already match these fields, but keep this tolerant
    // to allow partial objects (e.g., tests/mocks).
    return {
      ...(incoming as RawDiffResult),
      path,
      status,
      ...(oldPath ? { oldPath } : null),
    } as RawDiffResult;
  }, [repoRelativePath, fileStatus, oldPath]);

  useEffect(() => {
    // If caller provides diff, just render it.
    if (fileDiff && (reloadToken === 0 || !fetcher)) {
      setDiff(applyOverrides(fileDiff));
      setIsLoading(false);
      setError(null);
      return;
    }

    if (!repoPath || !repoRelativePath) {
      setDiff(null);
      setIsLoading(false);
      setError('No file selected');
      return;
    }

    if (!fetcher) {
      setDiff({
        path: repoRelativePath,
        status: normalizeStatus(fileStatus),
        binary: false,
        rawDiff: '',
        hasError: true,
        error: 'This diff view does not support loading raw text for the selected snapshots.',
      } as RawDiffResult);
      setIsLoading(false);
      setError('This diff view does not support loading raw text for the selected snapshots.');
      return;
    }

    let cancelled = false;
    const key = `${cacheKey(repoPath, repoRelativePath, oldSide, newSide)}::${JSON.stringify(textDiffSource)}`;
    const cached = textDiffCache.get(key);

    if (cached) {
      setDiff(applyOverrides(cached));
      setIsLoading(false);
      setError(cached.hasError ? (cached.error || 'Failed to load diff') : null);
      // Still allow explicit reload to re-fetch.
      if (reloadNonce === 0 && reloadToken === 0) return;
    }

    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const result = await fetcher.load();

        if (cancelled) return;

        const normalized = applyOverrides(result as unknown as RawDiffResult);
        textDiffCache.set(key, normalized);
        setDiff(normalized);
        setError(normalized.hasError ? (normalized.error || 'Failed to load diff') : null);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setDiff({
          path: repoRelativePath,
          status: normalizeStatus(fileStatus),
          binary: false,
          rawDiff: '',
          hasError: true,
          error: message || 'Failed to load diff',
        } as RawDiffResult);
        setError(message || 'Failed to load diff');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    repoPath,
    repoRelativePath,
    oldSide,
    newSide,
    fileStatus,
    oldPath,
    fileDiff,
    applyOverrides,
    fetcher,
    reloadNonce,
    reloadToken,
    textDiffSource,
  ]);

  // Loading state (only when we don't already have something to show)
  if (isLoading && !diff) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-theme-secondary">
        <Loader2 size={ICON_SIZES.md} className="animate-spin" />
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  // Hard error state (no diff object available)
  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-theme-error text-sm">
          <AlertCircle size={ICON_SIZES.sm} />
          <span>{error || 'Unable to load diff'}</span>
          <button
            type="button"
            className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-theme-muted text-theme-secondary"
            onClick={() => setReloadNonce((n) => n + 1)}
            title="Try again"
          >
            <RotateCcw size={ICON_SIZES.xs} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // A text selection must not route binary results back to a specialized viewer.
  if (diff.binary) {
    return <div className="p-4 text-sm text-theme-muted">This file cannot be displayed as a text diff.</div>;
  }

  // Delegate rendering to shared DiffViewer.
  return (
    <DiffViewer
      fileDiff={diff as any}
      showHeader={showHeader}
      repoPath={repoPath}
      oldSide={oldSide}
      newSide={newSide}
    />
  );
}

export default memo(TextDiffViewer);
