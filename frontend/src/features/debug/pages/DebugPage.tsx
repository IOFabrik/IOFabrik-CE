/**
 * DebugPage - Main area content for Debug Logs view.
 *
 * This hosts the full debug console (toggle, filters, live stream, export).
 */
import { memo, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowDown } from 'lucide-react';
import { onEvent } from '../../../shared/runtime/events';
import { toast } from 'sonner';
import {
  IsEnabled,
  SetEnabled,
  GetLogs,
  ClearLogs,
  ExportLogs,
  GetStats,
} from '../../../../bindings/iofabrik/services/debugservice';
import type {
  LogEntry,
  DebugStats,
} from '../../../../bindings/iofabrik/services/models';
import { LogFilter } from '../../../../bindings/iofabrik/services/models';
import DebugToggle from '../components/DebugToggle';
import LogFilterBar from '../components/LogFilterBar';
import LogEntryRow from '../components/LogEntryRow';
import StatsBar from '../components/StatsBar';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '../../../shared/ui';

const MAX_LOCAL_ENTRIES = 2000;
const STATS_REFRESH_MS = 3000;

function DebugPage(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<DebugStats>({
    enabled: false,
    totalEntries: 0,
    totalCommands: 0,
    totalMethods: 0,
    totalErrors: 0,
    bufferUsage: 0,
  } as DebugStats);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [contextTargetText, setContextTargetText] = useState('');

  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const [isOn, initialStats] = await Promise.all([IsEnabled(), GetStats()]);
        if (cancelled) return;
        setEnabled(isOn);
        setStats(initialStats);

        if (isOn) {
          const logs = await GetLogs(new LogFilter({ limit: MAX_LOCAL_ENTRIES }));
          if (!cancelled) setEntries(logs);
        }
      } catch {
        // Service may not be available yet during startup
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleNewLog = (entry: LogEntry) => {
      setEntries((prev) => {
        const next = [...prev, entry];
        if (next.length > MAX_LOCAL_ENTRIES) {
          return next.slice(next.length - MAX_LOCAL_ENTRIES);
        }
        return next;
      });
    };

    const handleStateChanged = (isEnabled: boolean) => {
      setEnabled(isEnabled);
    };

    const unsub1 = onEvent('debug:new-log', (event: any) => {
      const data = event?.data?.[0] ?? event;
      handleNewLog(data as LogEntry);
    });

    const unsub2 = onEvent('debug:state-changed', (event: any) => {
      const data = event?.data?.[0] ?? event;
      handleStateChanged(data as boolean);
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(async () => {
      try {
        const s = await GetStats();
        setStats(s);
      } catch {
        // Ignore refresh failures
      }
    }, STATS_REFRESH_MS);

    return () => clearInterval(interval);
  }, [enabled]);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const jumpToBottom = useCallback(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    setAutoScroll(true);
  }, []);

  const handleToggle = useCallback(async (value: boolean) => {
    try {
      await SetEnabled(value);
      setEnabled(value);

      if (value) {
        const logs = await GetLogs(new LogFilter({ limit: MAX_LOCAL_ENTRIES }));
        setEntries(logs);
        const s = await GetStats();
        setStats(s);
      }
    } catch {
      toast.error('Failed to toggle debug logging');
    }
  }, []);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const filePath = await ExportLogs();
      if (filePath) {
        toast.success(`Logs exported to ${filePath}`, { duration: 5000 });
      } else {
        toast.error('Export failed — check permissions');
      }
    } catch {
      toast.error('Failed to export logs');
    } finally {
      setIsExporting(false);
    }
  }, []);

  const handleClear = useCallback(async () => {
    try {
      await ClearLogs();
      setEntries([]);
      const s = await GetStats();
      setStats(s);
    } catch {
      toast.error('Failed to clear logs');
    }
  }, []);

  const filteredEntries = useMemo(() => {
    let result = entries;

    if (activeCategory) {
      result = result.filter((e) => e.category === activeCategory);
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          (e.message && e.message.toLowerCase().includes(q)) ||
          (e.source && e.source.toLowerCase().includes(q))
      );
    }

    return result;
  }, [entries, activeCategory, search]);

  const handleContextMenuCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const row = target.closest('[data-log-row]');
    const rowText = row?.textContent?.trim() || '';
    setContextTargetText(rowText);
  }, []);

  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textArea);
      return copied;
    }
  }, []);

  const handleCopyText = useCallback(async (): Promise<void> => {
    const selection = window.getSelection()?.toString().trim() || '';
    const textToCopy = selection || contextTargetText;

    if (!textToCopy) {
      toast.error('No text selected to copy');
      return;
    }

    const copied = await copyTextToClipboard(textToCopy);
    if (copied) {
      toast.success('Text copied');
    } else {
      toast.error('Failed to copy text');
    }
  }, [contextTargetText, copyTextToClipboard]);

  return (
    <div className="h-full min-h-0 flex flex-col select-text">
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-default shrink-0">
        <div>
          <h1 className="text-sm font-medium text-theme-primary">Debug Logs</h1>
          <p className="text-xs text-theme-muted mt-0.5">Live diagnostics for support and troubleshooting.</p>
        </div>
        <DebugToggle enabled={enabled} onToggle={handleToggle} />
      </div>

      <LogFilterBar
        search={search}
        onSearchChange={setSearch}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
      />

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={listRef}
            onScroll={handleScroll}
            onContextMenuCapture={handleContextMenuCapture}
            className="flex-1 overflow-y-auto overflow-x-hidden relative select-text"
            style={{ contentVisibility: 'auto' }}
          >
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-theme-muted text-sm gap-2 px-4 text-center">
                {!enabled ? (
                  <>
                    <p>Debug logging is off.</p>
                    <p>Turn it on above when support asks for logs.</p>
                  </>
                ) : entries.length === 0 ? (
                  <p>Waiting for log entries…</p>
                ) : (
                  <p>No entries match the current filter.</p>
                )}
              </div>
            ) : (
              filteredEntries.map((entry) => (
                <LogEntryRow key={entry.id} entry={entry} />
              ))
            )}

            {!autoScroll && filteredEntries.length > 0 && (
              <button
                onClick={jumpToBottom}
                className="sticky bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1
                         px-2.5 py-1 rounded-full text-[11px] font-medium
                         bg-blue-600 text-white shadow-lg hover:bg-blue-500 transition-colors z-10"
              >
                <ArrowDown size={12} />
                Jump to latest
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={handleCopyText}>Copy text</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <StatsBar
        stats={stats}
        onExport={handleExport}
        onClear={handleClear}
        isExporting={isExporting}
      />
    </div>
  );
}

export default memo(DebugPage);
