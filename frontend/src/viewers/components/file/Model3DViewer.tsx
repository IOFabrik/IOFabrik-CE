/**
 * Model3DViewer – Renders 3D model files inline (STL, OBJ, STEP, GLTF, etc.)
 *
 * Uses the Online3DViewer (OV) library which wraps three.js and supports 18+
 * import formats out of the box. File content is loaded through the Go backend
 * as base64 (Wails webviews cannot access file:// URLs) and converted to
 * browser File objects for OV's LoadModelFromFileList API.
 *
 * Features:
 * - Orbit, pan, and zoom controls (built into OV)
 * - Dark-theme background matching the app
 * - Loading and error states
 * - Caches base64 data to avoid redundant backend calls on tab switch
 * - Auto-refreshes when files change on disk (via files-changed event)
 * - Proper cleanup of WebGL resources on unmount
 */
import { memo, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AlertCircle, Loader2, Box } from 'lucide-react';
import { onEvent } from '../../../shared/runtime/events';
import { ICON_SIZES } from '../../../shared/constants';
import { ReadFileBase64 } from '../../../../bindings/iofabrik/services/filesystemservice';
import type { ViewerProps } from '../../registry/viewer-registry';
import { base64ToFile } from './model3d-utils';
import { getPathFileName } from '../shared/path-utils';

// ---------------------------------------------------------------------------
// Cache – avoids re-fetching base64 when switching tabs
// ---------------------------------------------------------------------------

interface CachedModel {
  /** Raw base64 data from backend */
  base64: string;
  /** File size in bytes */
  fileSize: number;
}

const modelCache = new Map<string, CachedModel>();

/**
 * Invalidate a specific file's model cache entry.
 */
export function invalidateModelCacheForFile(filePath: string): void {
  modelCache.delete(filePath);
}

/**
 * Clear all model cache entries.
 */
export function clearModelCache(): void {
  modelCache.clear();
}

// ---------------------------------------------------------------------------
// Model3DViewer Component
// ---------------------------------------------------------------------------

function Model3DViewer({ filePath }: ViewerProps): JSX.Element {
  const cached = modelCache.get(filePath);

  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(cached?.fileSize ?? null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const mountedRef = useRef(true);
  // Track whether OV module has been imported
  const ovModuleRef = useRef<any>(null);

  const fileName = useMemo(() => getPathFileName(filePath), [filePath]);
  const normalizedFilePath = useMemo(() => filePath.replace(/\\/g, '/'), [filePath]);

  // -----------------------------------------------------------------------
  // Format file size for display
  // -----------------------------------------------------------------------
  const formattedSize = useMemo(() => {
    if (fileSize == null) return null;
    if (fileSize < 1024) return `${fileSize} B`;
    if (fileSize < 1024 * 1024) return `${(fileSize / 1024).toFixed(1)} KB`;
    return `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;
  }, [fileSize]);

  // -----------------------------------------------------------------------
  // File change subscription – refresh when file changes on disk
  // -----------------------------------------------------------------------
  useEffect(() => {
    const handleFilesChanged = (event: {
      data?: {
        path?: string;
        eventType?: string;
        isDir?: boolean;
      };
    }) => {
      const changedPath = event.data?.path?.replace(/\\/g, '/');
      const eventType = event.data?.eventType;
      const isDir = event.data?.isDir;

      if (!changedPath || isDir) return;
      if (eventType !== 'write' && eventType !== 'rename' && eventType !== 'remove') return;

      // On Windows paths are case-insensitive; compare in lowercase.
      const samePath =
        changedPath === normalizedFilePath ||
        changedPath.toLowerCase() === normalizedFilePath.toLowerCase();

      if (!samePath) return;

      modelCache.delete(filePath);
      setRefreshCounter((c) => c + 1);
    };

    const unsubscribe = onEvent('files-changed', handleFilesChanged);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [filePath, normalizedFilePath]);

  // -----------------------------------------------------------------------
  // Destroy viewer on unmount or file change
  // -----------------------------------------------------------------------
  const destroyViewer = useCallback(() => {
    if (viewerRef.current) {
      try {
        viewerRef.current.Destroy();
      } catch {
        // Viewer may already be destroyed or DOM detached — safe to ignore
      }
      viewerRef.current = null;
    }
  }, []);

  // -----------------------------------------------------------------------
  // Load model from backend + initialize OV viewer
  // -----------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;

    // Always destroy previous viewer before loading a new one
    destroyViewer();

    let cancelled = false;

    async function loadAndRender() {
      try {
        // -----------------------------------------------------------------
        // 1. Get base64 data (from cache or backend)
        // -----------------------------------------------------------------
        let base64Data: string;
        let size: number;

        const cachedEntry = modelCache.get(filePath);
        if (cachedEntry) {
          base64Data = cachedEntry.base64;
          size = cachedEntry.fileSize;
        } else {
          setIsLoading(true);
          setError(null);

          const result = await ReadFileBase64(filePath);

          if (cancelled || !mountedRef.current) return;

          if (!result.success) {
            setError(result.error || 'Failed to read 3D model file');
            setIsLoading(false);
            return;
          }

          if (!result.data) {
            setError('File is empty');
            setIsLoading(false);
            return;
          }

          base64Data = result.data;
          size = result.size ?? 0;

          // Cache for tab-switch performance
          modelCache.set(filePath, { base64: base64Data, fileSize: size });
        }

        if (cancelled || !mountedRef.current) return;

        setFileSize(size);

        // -----------------------------------------------------------------
        // 2. Convert to browser File
        // -----------------------------------------------------------------
        const file = base64ToFile(base64Data, fileName);

        // -----------------------------------------------------------------
        // 3. Dynamically import OV (large dependency, only when needed)
        // -----------------------------------------------------------------
        if (!ovModuleRef.current) {
          ovModuleRef.current = await import('online-3d-viewer');
        }
        const OV = ovModuleRef.current;

        if (cancelled || !mountedRef.current || !containerRef.current) return;

        // -----------------------------------------------------------------
        // 4. Initialize EmbeddedViewer
        // -----------------------------------------------------------------
        const viewer = new OV.EmbeddedViewer(containerRef.current, {
          backgroundColor: new OV.RGBAColor(30, 30, 30, 255),
          defaultColor: new OV.RGBColor(180, 180, 180),
          onModelLoaded: () => {
            if (!cancelled && mountedRef.current) {
              setIsLoading(false);
            }
          },
          onModelLoadFailed: () => {
            if (!cancelled && mountedRef.current) {
              setError('Failed to parse 3D model. The file may be corrupted or use an unsupported variant.');
              setIsLoading(false);
            }
          },
        });

        viewerRef.current = viewer;

        // -----------------------------------------------------------------
        // 5. Load the model
        // -----------------------------------------------------------------
        viewer.LoadModelFromFileList([file]);
      } catch (err: any) {
        if (!cancelled && mountedRef.current) {
          setError(`Failed to load 3D model: ${err?.message || err}`);
          setIsLoading(false);
        }
      }
    }

    loadAndRender();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      destroyViewer();
    };
  }, [filePath, refreshCounter, fileName, destroyViewer]);

  // -----------------------------------------------------------------------
  // Resize observer – keep viewer in sync with container size
  // -----------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => {
      viewerRef.current?.Resize();
    });
    ro.observe(container);

    return () => ro.disconnect();
  }, []);

  // -----------------------------------------------------------------------
  // Error state
  // -----------------------------------------------------------------------
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-theme-secondary gap-3">
        <AlertCircle size={ICON_SIZES.lg} className="text-red-400" />
        <div className="text-center max-w-md">
          <p className="text-theme-primary font-medium mb-1">Cannot display 3D model</p>
          <p className="text-sm">{error}</p>
          <p className="text-xs text-theme-muted mt-2">{fileName}</p>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render – container div with loading overlay
  // -----------------------------------------------------------------------
  const metaParts: string[] = [];
  if (formattedSize) metaParts.push(formattedSize);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Metadata bar */}
      {metaParts.length > 0 && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-viewer-header border-b border-theme-default text-xs text-theme-muted shrink-0">
          <span className="flex items-center gap-1.5">
            <Box size={ICON_SIZES.xs} />
            <span>{metaParts.join('  •  ')}</span>
          </span>
          <span className="text-theme-muted/60">Orbit: drag • Zoom: scroll • Pan: right-drag</span>
        </div>
      )}

      {/* 3D viewer container */}
      <div className="flex-1 relative min-h-0">
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 bg-[rgb(30,30,30)]">
            <Loader2 size={ICON_SIZES.lg} className="animate-spin text-theme-secondary" />
            <span className="text-sm text-theme-muted mt-3">Loading {fileName}…</span>
          </div>
        )}
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ display: error ? 'none' : 'block' }}
        />
      </div>
    </div>
  );
}

export default memo(Model3DViewer);
