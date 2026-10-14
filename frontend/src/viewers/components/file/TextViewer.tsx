import { lazy, memo, Suspense, useCallback, useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { ReadTextFile } from '../../../../bindings/iofabrik/services/filesystemservice';
import { onEvent } from '../../../shared/runtime/events';
import { ICON_SIZES } from '../../../shared/constants';
import type { ViewerProps } from '../../registry/viewer-registry';
import { useCachedContent } from '../../registry/viewer-cache';
import { getPathFileName } from '../shared/path-utils';
import LoadingState from '../../../shared/ui/LoadingState';

const CodeMirrorTextViewer = lazy(() => import('../text/CodeMirrorTextViewer'));

/**
 * TextViewer component for displaying text-based files.
 * Part of the multi-viewer architecture.
 * Uses cached content to persist across tab switches.
 */
function TextViewer({ filePath }: ViewerProps): JSX.Element {
  // Loader function for cached content
  const loadFile = useCallback(async (): Promise<string> => {
    const result = await ReadTextFile(filePath);
    if (!result.success) {
      throw new Error(result.error || 'Failed to read file');
    }
    return result.content || '';
  }, [filePath]);

  // Use cached content - persists across tab/view switches
  const { data: content, error, isLoading, refresh } = useCachedContent<string>(
    filePath,
    loadFile
  );

  useEffect(() => onEvent('files-changed', (event: {
    data?: { path?: string; eventType?: string; isDir?: boolean };
  }) => {
    const changed = event.data;
    if (changed?.isDir || !changed?.path || !['write', 'rename', 'remove'].includes(changed.eventType ?? '')) return;
    if (changed.path.replace(/\\/g, '/').toLowerCase() === filePath.replace(/\\/g, '/').toLowerCase()) refresh();
  }), [filePath, refresh]);

  // Extract filename from path
  const fileName = getPathFileName(filePath);

  // Keep an already loaded editor mounted during watcher refreshes.
  if (isLoading && content === null) {
    return <LoadingState message={`Loading ${fileName}...`} />;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-theme-secondary gap-3">
        <AlertCircle size={ICON_SIZES.lg} className="text-red-400" />
        <div className="text-center">
          <p className="text-theme-primary font-medium mb-1">Cannot display file</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden" aria-busy={isLoading}>
      {isLoading && <div role="status" className="shrink-0 text-xs text-theme-muted">Refreshing file...</div>}
      <Suspense fallback={<LoadingState message="Loading text viewer..." />}>
        <CodeMirrorTextViewer key={filePath} content={content ?? ''} />
      </Suspense>
    </div>
  );
}

export default memo(TextViewer);
