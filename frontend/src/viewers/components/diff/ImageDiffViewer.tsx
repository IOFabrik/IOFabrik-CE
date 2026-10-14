/**
 * ImageDiffViewer — Visual comparison of image files across git revisions.
 *
 * Three view modes:
 *  1. **Side-by-side** — Old and new images shown next to each other.
 *  2. **Diff highlight** — imgdiff-generated overlay showing changed pixels in red.
 *  3. **Overlay / swipe** — Drag a slider to reveal old vs new (onion skin).
 *
 * Uses `react-photo-view` for fullscreen zoom/pan/rotate (same library as
 * ImageViewer.tsx). Images are transported as base64 from the Go backend
 * because Wails webviews cannot access file:// URLs.
 *
 * Data is loaded through the shared diff-side loaders so history, working-tree,
 * and merge-review flows all compare explicit old/new snapshots.
 */
import {
  memo,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { PhotoProvider, PhotoView } from 'react-photo-view';
import {
  AlertCircle,
  Loader2,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Minimize,
  Columns2,
  Layers,
  SlidersHorizontal,
  Plus,
  Minus,
  AlertTriangle,
  Equal,
  FileText,
} from 'lucide-react';
import { onEvent } from '../../../shared/runtime/events';

import { ICON_SIZES } from '../../../shared/constants';
import { ImageDiffResult } from '../../../../bindings/iofabrik/services/models';
import { formatFileSize, CHECKERBOARD_STYLE, ToolbarIcon } from '../file/image-utils';
import { getPathFileName } from '../shared/path-utils';
import type { DiffSide } from '../../registry/diff-registry';
import {
  loadBinarySide,
  serializeDiffSide,
  type BinarySidePayload,
} from './diff-side-loaders';
import { comparePages } from './pdf-diff-utils';

// ============================================================================
// Types
// ============================================================================

type DiffMode = 'side-by-side' | 'diff' | 'overlay';

export interface ImageDiffViewerProps {
  repoPath: string;
  filePath: string;
  oldSide: DiffSide;
  newSide: DiffSide;
}

// ============================================================================
// Cache — avoid re-fetching when switching tabs or modes
// ============================================================================

const imageDiffCache = new Map<string, ImageDiffResult>();

function cacheKey(
  repoPath: string,
  oldSide: DiffSide,
  newSide: DiffSide,
): string {
  return `image::${repoPath}::${serializeDiffSide(oldSide)}::${serializeDiffSide(newSide)}`;
}

// ============================================================================
// Toolbar Button (for mode toggle)
// ============================================================================

interface ToolbarBtnProps {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function ToolbarBtn({ active, disabled, onClick, title, children }: ToolbarBtnProps) {
  return (
    <button
      type="button"
      onClick={!disabled ? onClick : undefined}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded transition-colors ${
        active
          ? 'bg-theme-accent/20 text-theme-accent'
          : 'text-theme-muted hover:text-theme-primary hover:bg-theme-elevated'
      } ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Invalidate all working-tree diff caches.
 * Called when files change on disk to ensure fresh diffs are loaded.
 */
export function invalidateWorkingTreeImageDiffCache(): void {
  for (const key of imageDiffCache.keys()) {
    if (key.includes('::working:')) {
      imageDiffCache.delete(key);
    }
  }
}

/**
 * Invalidate a specific file's image diff cache entry.
 * @param repoPath - Repository path
 * @param filePath - File path
 */
export function invalidateImageDiffCacheForFile(repoPath: string, filePath: string): void {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

  for (const key of imageDiffCache.keys()) {
    if (!key.includes(`image::${repoPath}::`)) {
      continue;
    }

    if (key.toLowerCase().includes(`:${normalizedPath}`)) {
      imageDiffCache.delete(key);
    }
  }
}

function stripDataUrlPrefix(dataUrl: string | null): string | undefined {
  if (!dataUrl) {
    return undefined;
  }

  const separatorIndex = dataUrl.indexOf(',');
  if (separatorIndex === -1) {
    return undefined;
  }

  return dataUrl.slice(separatorIndex + 1);
}

function estimateBinarySize(base64Data?: string): number {
  if (!base64Data) {
    return 0;
  }

  const padding = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64Data.length * 3) / 4) - padding);
}

function inferImageMimeType(filePath: string): string {
  const normalizedPath = filePath.toLowerCase();
  if (normalizedPath.endsWith('.png')) return 'image/png';
  if (normalizedPath.endsWith('.jpg') || normalizedPath.endsWith('.jpeg')) return 'image/jpeg';
  if (normalizedPath.endsWith('.gif')) return 'image/gif';
  if (normalizedPath.endsWith('.webp')) return 'image/webp';
  if (normalizedPath.endsWith('.bmp')) return 'image/bmp';
  if (normalizedPath.endsWith('.svg')) return 'image/svg+xml';
  if (normalizedPath.endsWith('.tif') || normalizedPath.endsWith('.tiff')) return 'image/tiff';
  return 'image/png';
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode image data'));
    image.src = src;
  });
}

async function renderBinaryImage(
  payload: BinarySidePayload,
  fallbackMimeType: string,
): Promise<{ imageData: ImageData; width: number; height: number }> {
  const mimeType = payload.mimeType || fallbackMimeType;
  const image = await loadHtmlImage(`data:${mimeType};base64,${payload.base64Data}`);

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to get canvas 2d context for image diff');
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

  canvas.width = 0;
  canvas.height = 0;

  return {
    imageData,
    width: imageData.width,
    height: imageData.height,
  };
}

// ============================================================================
// Sub-components
// ============================================================================

// ---------------------------------------------------------------------------
// PhotoView toolbar (shared by side-by-side and diff-highlight modes)
// ---------------------------------------------------------------------------

function photoToolbar({
  scale,
  onScale,
  rotate,
  onRotate,
}: {
  scale: number;
  onScale: (v: number) => void;
  rotate: number;
  onRotate: (v: number) => void;
}) {
  return (
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
  );
}

// ---------------------------------------------------------------------------
// Side-by-side view
// ---------------------------------------------------------------------------

interface SideBySideProps {
  oldUrl: string | null;
  newUrl: string | null;
  result: ImageDiffResult;
}

const SideBySideView = memo(function SideBySideView({
  oldUrl,
  newUrl,
  result,
}: SideBySideProps) {
  return (
    <div className="flex-1 flex gap-4 p-4 overflow-auto min-h-0">
      {/* Old image */}
      <div className="flex-1 flex flex-col items-center gap-2 min-w-0">
        <span className="text-xs font-medium text-theme-muted uppercase tracking-wider">
          Before
        </span>
        {oldUrl ? (
          <PhotoProvider toolbarRender={photoToolbar} maskOpacity={0.92}>
            <PhotoView src={oldUrl}>
              <div
                className="relative cursor-zoom-in rounded-md overflow-hidden border border-theme-default shadow-md"
                style={CHECKERBOARD_STYLE}
              >
                <img
                  src={oldUrl}
                  alt="Before"
                  className="max-w-full max-h-[calc(100vh-320px)] object-contain block"
                  draggable={false}
                />
              </div>
            </PhotoView>
          </PhotoProvider>
        ) : (
          <div className="flex-1 flex items-center justify-center text-theme-muted text-sm italic">
            No previous version
          </div>
        )}
        {result.oldWidth > 0 && (
          <span className="text-xs text-theme-muted">
            {result.oldWidth} × {result.oldHeight}
            {result.oldSize > 0 && ` · ${formatFileSize(result.oldSize)}`}
          </span>
        )}
      </div>

      {/* Divider */}
      <div className="w-px bg-theme-default shrink-0" />

      {/* New image */}
      <div className="flex-1 flex flex-col items-center gap-2 min-w-0">
        <span className="text-xs font-medium text-theme-muted uppercase tracking-wider">
          After
        </span>
        {newUrl ? (
          <PhotoProvider toolbarRender={photoToolbar} maskOpacity={0.92}>
            <PhotoView src={newUrl}>
              <div
                className="relative cursor-zoom-in rounded-md overflow-hidden border border-theme-default shadow-md"
                style={CHECKERBOARD_STYLE}
              >
                <img
                  src={newUrl}
                  alt="After"
                  className="max-w-full max-h-[calc(100vh-320px)] object-contain block"
                  draggable={false}
                />
              </div>
            </PhotoView>
          </PhotoProvider>
        ) : (
          <div className="flex-1 flex items-center justify-center text-theme-muted text-sm italic">
            File deleted
          </div>
        )}
        {result.newWidth > 0 && (
          <span className="text-xs text-theme-muted">
            {result.newWidth} × {result.newHeight}
            {result.newSize > 0 && ` · ${formatFileSize(result.newSize)}`}
          </span>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Diff highlight view
// ---------------------------------------------------------------------------

interface DiffHighlightProps {
  diffUrl: string | null;
  result: ImageDiffResult;
}

const DiffHighlightView = memo(function DiffHighlightView({
  diffUrl,
  result,
}: DiffHighlightProps) {
  if (!diffUrl) {
    return (
      <div className="flex-1 flex items-center justify-center text-theme-muted text-sm">
        {result.isEqual
          ? 'Images are identical — no diff to display.'
          : 'Diff image not available (file was added or deleted).'}
      </div>
    );
  }

  const pct =
    result.totalPixels > 0
      ? ((result.diffPixelCount / result.totalPixels) * 100).toFixed(2)
      : '0';

  return (
    <div className="flex-1 flex flex-col items-center gap-3 p-4 overflow-auto min-h-0">
      <span className="text-xs text-theme-muted">
        Changed pixels are highlighted in{' '}
        <span className="text-red-400 font-medium">red</span> on a faded copy
        of the original.
      </span>

      <PhotoProvider toolbarRender={photoToolbar} maskOpacity={0.92}>
        <PhotoView src={diffUrl}>
          <div
            className="relative cursor-zoom-in rounded-md overflow-hidden border border-theme-default shadow-md"
            style={CHECKERBOARD_STYLE}
          >
            <img
              src={diffUrl}
              alt="Diff highlight"
              className="max-w-full max-h-[calc(100vh-320px)] object-contain block"
              draggable={false}
            />
          </div>
        </PhotoView>
      </PhotoProvider>

      <span className="text-xs text-theme-muted">
        {result.diffPixelCount.toLocaleString()} pixel
        {result.diffPixelCount !== 1 ? 's' : ''} changed ({pct}%)
      </span>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Overlay / swipe view
// ---------------------------------------------------------------------------

interface OverlayProps {
  oldUrl: string | null;
  newUrl: string | null;
}

const OverlayView = memo(function OverlayView({ oldUrl, newUrl }: OverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sliderX, setSliderX] = useState(0.5); // 0..1 from left
  const dragging = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setSliderX(x);
    },
    [],
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (!oldUrl || !newUrl) {
    return (
      <div className="flex-1 flex items-center justify-center text-theme-muted text-sm">
        Overlay mode requires both old and new images.
      </div>
    );
  }

  const clipRight = `${(1 - sliderX) * 100}%`;

  return (
    <div className="flex-1 flex flex-col items-center gap-3 p-4 overflow-auto min-h-0">
      <span className="text-xs text-theme-muted">
        Drag the slider to compare — <span className="text-blue-400">Before</span>{' '}
        (left) vs <span className="text-green-400">After</span> (right).
      </span>

      <div
        ref={containerRef}
        className="relative inline-block rounded-md overflow-hidden border border-theme-default shadow-md select-none"
        style={CHECKERBOARD_STYLE}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Bottom layer: OLD image (fully visible) */}
        <img
          src={oldUrl}
          alt="Before"
          className="block max-w-full max-h-[calc(100vh-320px)] object-contain"
          draggable={false}
        />

        {/* Top layer: NEW image (clipped by slider) */}
        <img
          src={newUrl}
          alt="After"
          className="absolute inset-0 block max-w-full max-h-[calc(100vh-320px)] object-contain"
          style={{ clipPath: `inset(0 ${clipRight} 0 0)` }}
          draggable={false}
        />

        {/* Slider handle */}
        <div
          className="absolute top-0 bottom-0 w-[3px] bg-white/80 cursor-col-resize z-10"
          style={{ left: `${sliderX * 100}%`, transform: 'translateX(-50%)' }}
          onPointerDown={handlePointerDown}
        >
          {/* Knob */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white shadow-md border border-gray-300 flex items-center justify-center">
            <SlidersHorizontal size={12} className="text-gray-600" />
          </div>
        </div>

        {/* Side labels */}
        <span className="absolute top-2 left-2 text-[10px] font-semibold uppercase tracking-wider bg-blue-500/80 text-white px-1.5 py-0.5 rounded">
          Before
        </span>
        <span className="absolute top-2 right-2 text-[10px] font-semibold uppercase tracking-wider bg-green-500/80 text-white px-1.5 py-0.5 rounded">
          After
        </span>
      </div>
    </div>
  );
});

// ============================================================================
// ============================================================================
// Stats Bar
// ============================================================================

interface StatsBarProps {
  result: ImageDiffResult;
}

const StatsBar = memo(function StatsBar({ result }: StatsBarProps) {
  const parts: string[] = [];

  // Diff pixel count
  if (result.status === 'modified') {
    parts.push(
      `${result.diffPixelCount.toLocaleString()} pixel${result.diffPixelCount !== 1 ? 's' : ''} changed`,
    );

    if (result.totalPixels > 0) {
      const pct = ((result.diffPixelCount / result.totalPixels) * 100).toFixed(2);
      parts.push(`${pct}% of image`);
    }
  }

  // Dimensions
  const dimChanged =
    result.oldWidth !== result.newWidth || result.oldHeight !== result.newHeight;
  if (result.oldWidth > 0 && result.newWidth > 0) {
    if (dimChanged) {
      parts.push(
        `${result.oldWidth}×${result.oldHeight} → ${result.newWidth}×${result.newHeight}`,
      );
    } else {
      parts.push(`${result.newWidth}×${result.newHeight}`);
    }
  } else if (result.newWidth > 0) {
    parts.push(`${result.newWidth}×${result.newHeight}`);
  } else if (result.oldWidth > 0) {
    parts.push(`${result.oldWidth}×${result.oldHeight}`);
  }

  // File sizes
  if (result.oldSize > 0 && result.newSize > 0) {
    const delta = result.newSize - result.oldSize;
    const pct =
      result.oldSize > 0
        ? ((delta / result.oldSize) * 100).toFixed(0)
        : '0';
    const sign = delta >= 0 ? '+' : '';
    parts.push(
      `${formatFileSize(result.oldSize)} → ${formatFileSize(result.newSize)} (${sign}${pct}%)`,
    );
  } else if (result.newSize > 0) {
    parts.push(formatFileSize(result.newSize));
  } else if (result.oldSize > 0) {
    parts.push(formatFileSize(result.oldSize));
  }

  return (
    <div className="flex items-center gap-3 px-4 py-1 bg-viewer-header border-b border-theme-default text-xs text-theme-muted shrink-0 flex-wrap">
      {/* Status badge */}
      {result.status === 'added' && (
        <span className="flex items-center gap-1 text-green-400 font-medium">
          <Plus size={ICON_SIZES.xs} /> Added
        </span>
      )}
      {result.status === 'deleted' && (
        <span className="flex items-center gap-1 text-red-400 font-medium">
          <Minus size={ICON_SIZES.xs} /> Deleted
        </span>
      )}
      {result.status === 'modified' && result.isEqual && (
        <span className="flex items-center gap-1 text-blue-400 font-medium">
          <Equal size={ICON_SIZES.xs} /> Identical
        </span>
      )}

      {/* Dimension change warning */}
      {dimChanged && result.oldWidth > 0 && result.newWidth > 0 && (
        <span className="flex items-center gap-1 text-yellow-400">
          <AlertTriangle size={ICON_SIZES.xs} /> Dimensions changed
        </span>
      )}

      {/* Stats */}
      {parts.length > 0 && (
        <span>{parts.join('  •  ')}</span>
      )}
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

function ImageDiffViewer({
  repoPath,
  filePath,
  oldSide,
  newSide,
}: ImageDiffViewerProps): JSX.Element {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const key = useMemo(
    () => cacheKey(repoPath, oldSide, newSide),
    [repoPath, oldSide, newSide],
  );
  const cached = key ? imageDiffCache.get(key) : undefined;

  const [result, setResult] = useState<ImageDiffResult | null>(cached ?? null);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  // Counter to force re-fetch when files change on disk (for working tree diffs)
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Persist mode preference
  const [mode, setMode] = useState<DiffMode>(
    () => (localStorage.getItem('image-diff-mode') as DiffMode) || 'side-by-side',
  );

  const mountedRef = useRef(true);

  const fileName = useMemo(
    () => getPathFileName(filePath),
    [filePath],
  );
  const usesWorkingTree = useMemo(
    () => oldSide.kind === 'working' || newSide.kind === 'working',
    [oldSide, newSide],
  );
  const normalizedTargetPath = useMemo(() => {
    const workingSide = newSide.kind === 'working'
      ? newSide
      : oldSide.kind === 'working'
        ? oldSide
        : null;
    return workingSide?.absolutePath.replace(/\\/g, '/').toLowerCase() ?? null;
  }, [newSide, oldSide]);

  // ---------------------------------------------------------------------------
  // File change subscription (for working tree diffs)
  // When files change on disk, invalidate cache and trigger re-fetch.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!usesWorkingTree || !normalizedTargetPath) return;

    const handleFilesChanged = (event: {
      data?: {
        path?: string;
        eventType?: string;
        isDir?: boolean;
      };
    }) => {
      const changedPath = event.data?.path?.replace(/\\/g, '/').toLowerCase();
      const eventType = event.data?.eventType;
      const isDir = event.data?.isDir;

      if (!changedPath || isDir) return;
      if (eventType !== 'write' && eventType !== 'rename' && eventType !== 'remove') return;
      if (changedPath !== normalizedTargetPath) return;

      imageDiffCache.delete(key);
      setRefreshCounter((c) => c + 1);
    };

    const unsubscribe = onEvent('files-changed', handleFilesChanged);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [key, normalizedTargetPath, usesWorkingTree]);

  const handleReload = useCallback(() => {
    imageDiffCache.delete(key);
    setRefreshCounter((c) => c + 1);
  }, [key]);

  // ---------------------------------------------------------------------------
  // Mode change handler — persist to localStorage
  // ---------------------------------------------------------------------------

  const handleModeChange = useCallback((m: DiffMode) => {
    setMode(m);
    localStorage.setItem('image-diff-mode', m);
  }, []);

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts: 1/2/3 to switch modes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't capture when focus is in an input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === '1') handleModeChange('side-by-side');
      else if (e.key === '2') handleModeChange('diff');
      else if (e.key === '3') handleModeChange('overlay');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleModeChange]);

  // ---------------------------------------------------------------------------
  // Fetch data from backend
  // ---------------------------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;

    // Use cache when available
    if (imageDiffCache.has(key)) {
      const c = imageDiffCache.get(key)!;
      setResult(c);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    let cancelled = false;
    const activeSides = { oldSide, newSide };

    async function load() {
      try {
        const [oldResult, newResult] = await Promise.allSettled([
          loadBinarySide(repoPath, activeSides.oldSide),
          loadBinarySide(repoPath, activeSides.newSide),
        ]);

        if (cancelled || !mountedRef.current) return;

        if (oldResult.status === 'rejected' || newResult.status === 'rejected') {
          const oldMessage = oldResult.status === 'rejected'
            ? oldResult.reason instanceof Error ? oldResult.reason.message : String(oldResult.reason)
            : null;
          const newMessage = newResult.status === 'rejected'
            ? newResult.reason instanceof Error ? newResult.reason.message : String(newResult.reason)
            : null;
          setError(newMessage || oldMessage || 'Could not load one of the image versions.');
          setIsLoading(false);
          return;
        }

        const oldPayload = oldResult.status === 'fulfilled' ? oldResult.value : null;
        const newPayload = newResult.status === 'fulfilled' ? newResult.value : null;

        if (!oldPayload && !newPayload) {
          setError('Could not load either version of the image.');
          setIsLoading(false);
          return;
        }

        const fallbackMimeType = newPayload?.mimeType || oldPayload?.mimeType || inferImageMimeType(filePath);
        const [oldRaster, newRaster] = await Promise.all([
          oldPayload ? renderBinaryImage(oldPayload, fallbackMimeType) : Promise.resolve(null),
          newPayload ? renderBinaryImage(newPayload, fallbackMimeType) : Promise.resolve(null),
        ]);

        if (cancelled || !mountedRef.current) return;

        const comparison = comparePages(oldRaster?.imageData ?? null, newRaster?.imageData ?? null);
        const status = !oldPayload ? 'added' : !newPayload ? 'deleted' : 'modified';
        const computedResult = new ImageDiffResult({
          success: true,
          oldImage: stripDataUrlPrefix(comparison.oldDataUrl),
          newImage: stripDataUrlPrefix(comparison.newDataUrl),
          diffImage: stripDataUrlPrefix(comparison.diffDataUrl),
          mimeType: 'image/png',
          oldWidth: oldRaster?.width ?? 0,
          oldHeight: oldRaster?.height ?? 0,
          newWidth: newRaster?.width ?? 0,
          newHeight: newRaster?.height ?? 0,
          oldSize: oldPayload?.size ?? estimateBinarySize(oldPayload?.base64Data),
          newSize: newPayload?.size ?? estimateBinarySize(newPayload?.base64Data),
          diffPixelCount: comparison.diffPixelCount,
          totalPixels: comparison.totalPixels,
          isEqual: status === 'modified' ? comparison.isEqual : false,
          status,
        });

        imageDiffCache.set(key, computedResult);
        setResult(computedResult);
        setIsLoading(false);
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          const message = err instanceof Error ? err.message : String(err);
          setError(`Failed to compute image diff: ${message}`);
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [filePath, key, newSide, oldSide, refreshCounter, repoPath]);

  // ---------------------------------------------------------------------------
  // Derived data URLs
  // ---------------------------------------------------------------------------

  const oldUrl = useMemo(
    () =>
      result?.oldImage
        ? `data:${result.mimeType};base64,${result.oldImage}`
        : null,
    [result],
  );

  const newUrl = useMemo(
    () =>
      result?.newImage
        ? `data:${result.mimeType};base64,${result.newImage}`
        : null,
    [result],
  );

  // Diff image is always PNG regardless of source format
  const diffUrl = useMemo(
    () =>
      result?.diffImage
        ? `data:image/png;base64,${result.diffImage}`
        : null,
    [result],
  );

  const hasBothSides = Boolean(oldUrl && newUrl);
  const hasDiffImage = Boolean(diffUrl);

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-theme-secondary gap-3">
        <AlertCircle size={ICON_SIZES.lg} className="text-red-400" />
        <div className="text-center max-w-md">
          <p className="text-theme-primary font-medium mb-1">
            Cannot display image diff
          </p>
          <p className="text-sm">{error}</p>
          <p className="text-xs text-theme-muted mt-2">{fileName}</p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (isLoading || !result) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2
          size={ICON_SIZES.lg}
          className="animate-spin text-theme-secondary"
        />
        <span className="text-sm text-theme-muted">
          Computing image diff for {fileName}…
        </span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-theme-default bg-viewer-header shrink-0">
        <div className="flex items-center gap-3">
          <FileText size={ICON_SIZES.sm} className="text-theme-secondary" />
          <span className="text-sm text-theme-primary font-medium truncate max-w-[300px]">{fileName}</span>
          <span className={`text-xs font-medium uppercase ${
            result.status === 'added' ? 'text-theme-added' :
            result.status === 'deleted' ? 'text-theme-removed' : 'text-theme-modified'
          }`}>
            {result.status}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center gap-0.5 border border-theme-default rounded-md p-0.5">
            <ToolbarBtn
              active={mode === 'side-by-side'}
              onClick={() => handleModeChange('side-by-side')}
              title="Side by side (1)"
            >
              <Columns2 size={14} />
            </ToolbarBtn>
            <ToolbarBtn
              active={mode === 'diff'}
              disabled={!hasDiffImage}
              onClick={() => handleModeChange('diff')}
              title="Diff highlight (2)"
            >
              <Layers size={14} />
            </ToolbarBtn>
            <ToolbarBtn
              active={mode === 'overlay'}
              disabled={!hasBothSides}
              onClick={() => handleModeChange('overlay')}
              title="Overlay slider (3)"
            >
              <SlidersHorizontal size={14} />
            </ToolbarBtn>
          </div>

          <ToolbarBtn
            onClick={handleReload}
            title="Reload diff"
          >
            <RefreshCw size={14} />
          </ToolbarBtn>
        </div>
      </div>

      {/* Stats bar */}
      <StatsBar result={result} />

      {/* Active mode view */}
      {mode === 'side-by-side' && (
        <SideBySideView oldUrl={oldUrl} newUrl={newUrl} result={result} />
      )}
      {mode === 'diff' && (
        <DiffHighlightView diffUrl={diffUrl} result={result} />
      )}
      {mode === 'overlay' && (
        <OverlayView oldUrl={oldUrl} newUrl={newUrl} />
      )}
    </div>
  );
}

export default memo(ImageDiffViewer);
