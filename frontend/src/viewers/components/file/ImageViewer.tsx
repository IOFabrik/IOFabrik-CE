/**
 * ImageViewer - Displays image files with zoom, pan, and rotate support.
 *
 * Uses react-photo-view for fullscreen preview with gestures, and
 * Go backend ReadFileBase64 to load images as data URLs (since file://
 * URLs are not available in Wails webviews).
 *
 * Features:
 * - Loads images via backend base64 encoding (works in Wails webview)
 * - Inline preview with checkerboard transparency background
 * - Click to open fullscreen viewer with:
 *   - Pinch/scroll zoom
 *   - Pan/drag
 *   - Rotate (90° increments)
 *   - Zoom in/out buttons
 * - Displays image dimensions and file size
 * - Loading and error states
 * - Caches loaded data URLs to avoid redundant backend calls
 * - Auto-refreshes when files change on disk (via files-changed event)
 */
import { memo, useState, useMemo, useEffect, useRef } from 'react';
import { PhotoProvider, PhotoView } from 'react-photo-view';
import {
  AlertCircle,
  Loader2,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Minimize,
} from 'lucide-react';
import { onEvent } from '../../../shared/runtime/events';
import { ICON_SIZES } from '../../../shared/constants';
import { ReadFileBase64 } from '../../../../bindings/iofabrik/services/filesystemservice';
import type { ViewerProps } from '../../registry/viewer-registry';
import { formatFileSize, CHECKERBOARD_STYLE, ToolbarIcon } from './image-utils';
import { getPathFileName } from '../shared/path-utils';

// ---------------------------------------------------------------------------
// Cache – avoids re-fetching base64 when switching tabs
// ---------------------------------------------------------------------------

interface CachedImage {
  dataUrl: string;
  width: number;
  height: number;
  fileSize: number;
}

const imageCache = new Map<string, CachedImage>();

/**
 * Invalidate a specific file's image cache entry.
 * @param filePath - Absolute file path
 */
export function invalidateImageCacheForFile(filePath: string): void {
  imageCache.delete(filePath);
}

/**
 * Clear all image cache entries.
 */
export function clearImageCache(): void {
  imageCache.clear();
}

// ---------------------------------------------------------------------------
// ImageViewer Component
// ---------------------------------------------------------------------------

function ImageViewer({ filePath }: ViewerProps): JSX.Element {
  const cached = imageCache.get(filePath);

  const [dataUrl, setDataUrl] = useState<string | null>(cached?.dataUrl ?? null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(
    cached ? { width: cached.width, height: cached.height } : null,
  );
  const [fileSize, setFileSize] = useState<number | null>(cached?.fileSize ?? null);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  // Counter to force re-fetch when files change on disk
  const [refreshCounter, setRefreshCounter] = useState(0);
  const mountedRef = useRef(true);

  const fileName = useMemo(() => getPathFileName(filePath), [filePath]);
  const normalizedFilePath = useMemo(() => {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized;
  }, [filePath]);

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

      // Invalidate this file's cache entry and bump counter to trigger re-fetch
      imageCache.delete(filePath);
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
  // Load image from backend
  // -----------------------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;

    // Already cached – skip backend call
    if (imageCache.has(filePath)) {
      const c = imageCache.get(filePath)!;
      setDataUrl(c.dataUrl);
      setDimensions({ width: c.width, height: c.height });
      setFileSize(c.fileSize);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    ReadFileBase64(filePath)
      .then((result) => {
        if (!mountedRef.current) return;

        if (!result.success) {
          setError(result.error || 'Failed to load image');
          setIsLoading(false);
          return;
        }

        const url = `data:${result.mimeType};base64,${result.data}`;
        setDataUrl(url);
        setFileSize(result.size ?? 0);

        // Decode to get natural dimensions
        const img = new Image();
        img.onload = () => {
          if (!mountedRef.current) return;
          const dims = { width: img.naturalWidth, height: img.naturalHeight };
          setDimensions(dims);
          setIsLoading(false);

          // Cache for tab-switch performance
          imageCache.set(filePath, {
            dataUrl: url,
            width: dims.width,
            height: dims.height,
            fileSize: result.size ?? 0,
          });
        };
        img.onerror = () => {
          if (!mountedRef.current) return;
          setError('Image data is corrupted or unsupported.');
          setIsLoading(false);
        };
        img.src = url;
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setError(`Failed to read file: ${err?.message || err}`);
        setIsLoading(false);
      });

    return () => {
      mountedRef.current = false;
    };
  }, [filePath, refreshCounter]);

  // -----------------------------------------------------------------------
  // Error state
  // -----------------------------------------------------------------------

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-theme-secondary gap-3">
        <AlertCircle size={ICON_SIZES.lg} className="text-red-400" />
        <div className="text-center max-w-md">
          <p className="text-theme-primary font-medium mb-1">Cannot display image</p>
          <p className="text-sm">{error}</p>
          <p className="text-xs text-theme-muted mt-2">{fileName}</p>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------

  if (isLoading || !dataUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 size={ICON_SIZES.lg} className="animate-spin text-theme-secondary" />
        <span className="text-sm text-theme-muted">Loading {fileName}…</span>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Loaded – render preview + fullscreen viewer
  // -----------------------------------------------------------------------

  const metaParts: string[] = [];
  if (dimensions) metaParts.push(`${dimensions.width} × ${dimensions.height}`);
  if (fileSize != null) metaParts.push(formatFileSize(fileSize));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Metadata bar */}
      {metaParts.length > 0 && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-viewer-header border-b border-theme-default text-xs text-theme-muted shrink-0">
          <span>{metaParts.join('  •  ')}</span>
          <span className="text-theme-muted/60">Click image to preview</span>
        </div>
      )}

      {/* Image display area */}
      <div className="flex-1 overflow-auto flex items-center justify-center p-6">
        <PhotoProvider
          maskOpacity={0.92}
          toolbarRender={({ scale, onScale, rotate, onRotate }) => (
            <>
              <ToolbarIcon onClick={() => onScale(scale + 0.5)} title="Zoom in">
                <ZoomIn size={18} />
              </ToolbarIcon>
              <ToolbarIcon onClick={() => onScale(scale - 0.5)} title="Zoom out">
                <ZoomOut size={18} />
              </ToolbarIcon>
              <ToolbarIcon onClick={() => onScale(1)} title="Actual size">
                <Minimize size={18} />
              </ToolbarIcon>
              <ToolbarIcon onClick={() => onRotate(rotate + 90)} title="Rotate 90°">
                <RotateCw size={18} />
              </ToolbarIcon>
            </>
          )}
        >
          <PhotoView src={dataUrl}>
            {/* Inline clickable preview */}
            <div
              className="relative cursor-zoom-in rounded-md overflow-hidden border border-theme-default shadow-lg"
              style={CHECKERBOARD_STYLE}
            >
              <img
                src={dataUrl}
                alt={fileName}
                className="max-w-full max-h-[calc(100vh-220px)] object-contain block"
                style={{
                  imageRendering:
                    dimensions && dimensions.width < 200 ? 'pixelated' : 'auto',
                }}
                draggable={false}
              />
            </div>
          </PhotoView>
        </PhotoProvider>
      </div>
    </div>
  );
}

export default memo(ImageViewer);
