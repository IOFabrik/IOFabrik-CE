/**
 * PDFViewer - Displays PDF files using react-pdf with virtualized rendering.
 *
 * Uses the Go backend ReadFileBase64 to load PDFs as data URLs (since file://
 * URLs are not available in Wails webviews), then renders pages via
 * react-pdf's Document + Page components with @tanstack/react-virtual for
 * virtualization – only pages in/near the viewport are rendered to the DOM.
 *
 * Features:
 * - Virtualized page rendering (handles 1000+ page PDFs efficiently)
 * - Loads PDFs via backend base64 encoding (works in Wails webview)
 * - Scrollable multi-page view with overscan
 * - Page navigation controls (prev / next / jump-to-page)
 * - Zoom in / out with predefined levels
 * - Displays page count and current page indicator
 * - Loading and error states with user-friendly messages
 * - LRU cache for loaded data URLs (max 5 entries)
 */
import { memo, useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  Loader2,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  FileText,
} from 'lucide-react';
import { ICON_SIZES } from '../../../shared/constants';
import { ReadFileBase64 } from '../../../../bindings/iofabrik/services/filesystemservice';
import type { ViewerProps } from '../../registry/viewer-registry';
import { getPathFileName } from '../shared/path-utils';

import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

// ---------------------------------------------------------------------------
// pdf.js worker configuration
// ---------------------------------------------------------------------------

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Predefined zoom levels for consistent stepping */
const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const DEFAULT_ZOOM_INDEX = 2; // 1.0 = 100%

/** Estimated height of a standard PDF page (US Letter, 792pt at 72 DPI) */
const ESTIMATED_PAGE_HEIGHT = 792;

/** Vertical gap between pages in pixels */
const PAGE_GAP = 16;

/** Vertical padding at start/end of the page list */
const PAGE_PADDING = 16;

/** Number of extra pages to render above/below the viewport */
const OVERSCAN_COUNT = 2;

// ---------------------------------------------------------------------------
// Cache – LRU with size limit to avoid unbounded memory growth
// ---------------------------------------------------------------------------

const MAX_PDF_CACHE_ENTRIES = 5;
const pdfCache = new Map<string, string>();

/** Add to the PDF cache with LRU eviction */
function cachePdf(filePath: string, dataUrl: string): void {
  // Delete + re-add moves entry to end (most recent) for LRU ordering
  pdfCache.delete(filePath);
  if (pdfCache.size >= MAX_PDF_CACHE_ENTRIES) {
    const oldest = pdfCache.keys().next().value;
    if (oldest !== undefined) pdfCache.delete(oldest);
  }
  pdfCache.set(filePath, dataUrl);
}

// ---------------------------------------------------------------------------
// PDFViewer Component
// ---------------------------------------------------------------------------

function PDFViewer({ filePath }: ViewerProps): JSX.Element {
  const cached = pdfCache.get(filePath);

  const [dataUrl, setDataUrl] = useState<string | null>(cached ?? null);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [pageInputValue, setPageInputValue] = useState<string>('1');

  const parentRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(1);

  const fileName = useMemo(() => getPathFileName(filePath), [filePath]);
  const scale = ZOOM_LEVELS[zoomIndex];
  const zoomPercent = Math.round(scale * 100);

  // -----------------------------------------------------------------------
  // Virtualizer – only renders pages in/near the viewport
  // -----------------------------------------------------------------------

  const rowVirtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(
      () => Math.round(ESTIMATED_PAGE_HEIGHT * scale),
      [scale],
    ),
    gap: PAGE_GAP,
    paddingStart: PAGE_PADDING,
    paddingEnd: PAGE_PADDING,
    overscan: OVERSCAN_COUNT,
  });

  // Reset all measurements when zoom level changes
  useEffect(() => {
    rowVirtualizer.measure();
  }, [scale, rowVirtualizer]);

  // -----------------------------------------------------------------------
  // Load PDF from backend
  // -----------------------------------------------------------------------

  useEffect(() => {
    let mounted = true;

    // Already cached – skip backend call
    if (pdfCache.has(filePath)) {
      setDataUrl(pdfCache.get(filePath)!);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    ReadFileBase64(filePath)
      .then((result) => {
        if (!mounted) return;

        if (!result.success) {
          setError(result.error || 'Failed to load PDF');
          setIsLoading(false);
          return;
        }

        const url = `data:application/pdf;base64,${result.data}`;
        setDataUrl(url);
        setIsLoading(false);

        // Cache with LRU eviction for tab-switch performance
        cachePdf(filePath, url);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(`Failed to read file: ${err?.message || err}`);
        setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [filePath]);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const onDocumentLoadSuccess = useCallback(({ numPages: total }: { numPages: number }) => {
    setNumPages(total);
    setCurrentPage(1);
    setPageInputValue('1');
  }, []);

  const onDocumentLoadError = useCallback((err: Error) => {
    setError(`PDF rendering failed: ${err.message}`);
  }, []);

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(page, numPages));
      setCurrentPage(clamped);
      setPageInputValue(String(clamped));
      currentPageRef.current = clamped;

      // Use virtualizer for efficient scroll-to-page
      rowVirtualizer.scrollToIndex(clamped - 1, { align: 'start', behavior: 'smooth' });
    },
    [numPages, rowVirtualizer],
  );

  const handlePageInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPageInputValue(e.target.value);
    },
    [],
  );

  const handlePageInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const parsed = parseInt(pageInputValue, 10);
        if (!isNaN(parsed)) {
          goToPage(parsed);
        }
      }
    },
    [pageInputValue, goToPage],
  );

  const handlePageInputBlur = useCallback(() => {
    const parsed = parseInt(pageInputValue, 10);
    if (!isNaN(parsed)) {
      goToPage(parsed);
    } else {
      setPageInputValue(String(currentPage));
    }
  }, [pageInputValue, currentPage, goToPage]);

  const zoomIn = useCallback(() => {
    setZoomIndex((prev) => Math.min(prev + 1, ZOOM_LEVELS.length - 1));
  }, []);

  const zoomOut = useCallback(() => {
    setZoomIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  // Track current page from virtualizer scroll position
  const handleScroll = useCallback(() => {
    const range = rowVirtualizer.range;
    if (range && numPages > 0) {
      const newPage = range.startIndex + 1;
      if (newPage !== currentPageRef.current) {
        currentPageRef.current = newPage;
        setCurrentPage(newPage);
        setPageInputValue(String(newPage));
      }
    }
  }, [rowVirtualizer, numPages]);

  // -----------------------------------------------------------------------
  // Error state
  // -----------------------------------------------------------------------

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-theme-secondary gap-3">
        <AlertCircle size={ICON_SIZES.lg} className="text-red-400" />
        <div className="text-center max-w-md">
          <p className="text-theme-primary font-medium mb-1">Cannot display PDF</p>
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
  // Loaded – render PDF with toolbar
  // -----------------------------------------------------------------------

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-viewer-header border-b border-theme-default text-xs text-theme-muted shrink-0">
        {/* Page navigation */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="p-1 rounded hover:bg-theme-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Previous page"
          >
            <ChevronLeft size={16} />
          </button>

          <div className="flex items-center gap-1">
            <input
              type="text"
              value={pageInputValue}
              onChange={handlePageInputChange}
              onKeyDown={handlePageInputKeyDown}
              onBlur={handlePageInputBlur}
              className="w-10 text-center bg-theme-elevated border border-theme-default rounded px-1 py-0.5 text-xs text-theme-primary focus:outline-none focus:border-accent-primary"
              aria-label="Current page"
            />
            <span>of {numPages}</span>
          </div>

          <button
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= numPages}
            className="p-1 rounded hover:bg-theme-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={zoomOut}
            disabled={zoomIndex <= 0}
            className="p-1 rounded hover:bg-theme-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Zoom out"
          >
            <ZoomOut size={16} />
          </button>

          <span className="w-12 text-center tabular-nums">{zoomPercent}%</span>

          <button
            onClick={zoomIn}
            disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
            className="p-1 rounded hover:bg-theme-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Zoom in"
          >
            <ZoomIn size={16} />
          </button>
        </div>

        {/* Page count */}
        <div className="flex items-center gap-1.5">
          <FileText size={14} />
          <span>{numPages} {numPages === 1 ? 'page' : 'pages'}</span>
        </div>
      </div>

      {/* PDF rendering area – virtualized for large document support */}
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-theme-surface"
      >
        <Document
          file={dataUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading={
            <div className="flex items-center justify-center h-full gap-2 py-12">
              <Loader2 size={ICON_SIZES.md} className="animate-spin text-theme-secondary" />
              <span className="text-sm text-theme-muted">Rendering PDF…</span>
            </div>
          }
          error={
            <div className="flex flex-col items-center justify-center h-full gap-2 py-12">
              <AlertCircle size={ICON_SIZES.md} className="text-red-400" />
              <span className="text-sm text-theme-secondary">Failed to render PDF</span>
            </div>
          }
        >
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="flex justify-center"
              >
                <Page
                  pageNumber={virtualRow.index + 1}
                  scale={scale}
                  loading={
                    <div
                      className="flex items-center justify-center"
                      style={{ height: Math.round(ESTIMATED_PAGE_HEIGHT * scale) }}
                    >
                      <Loader2 size={ICON_SIZES.md} className="animate-spin text-theme-secondary" />
                    </div>
                  }
                  className="shadow-lg"
                />
              </div>
            ))}
          </div>
        </Document>
      </div>
    </div>
  );
}

export default memo(PDFViewer);
