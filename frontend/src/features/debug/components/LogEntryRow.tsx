/**
 * LogEntryRow - A single expandable log entry in the debug log list.
 * Color-coded by level. Click to expand/collapse details panel.
 */
import { memo, useState, useCallback, type CSSProperties } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { ICON_SIZES } from '../../../shared/constants';
import type { LogEntry } from '../../../../bindings/iofabrik/services/models';

// ============================================================================
// Helpers
// ============================================================================

const chevronStyle: CSSProperties = { width: ICON_SIZES.xs, height: ICON_SIZES.xs };

/** Level → Tailwind text color */
function levelColor(level: string): string {
  switch (level) {
    case 'error': return 'text-red-400';
    case 'warn': return 'text-amber-400';
    case 'debug': return 'text-gray-500';
    default: return 'text-theme-secondary'; // info
  }
}

/** Level → short uppercase label */
function levelLabel(level: string): string {
  return (level || 'info').toUpperCase().padEnd(5);
}

/** Category → badge color classes */
function categoryBadge(category: string): string {
  switch (category) {
    case 'command': return 'bg-cyan-500/15 text-cyan-400';
    case 'method': return 'bg-purple-500/15 text-purple-400';
    case 'error': return 'bg-red-500/15 text-red-400';
    case 'lifecycle': return 'bg-green-500/15 text-green-400';
    case 'event': return 'bg-yellow-500/15 text-yellow-400';
    default: return 'bg-gray-500/15 text-gray-400';
  }
}

/** Format timestamp to HH:MM:SS.mmm */
function formatTime(ts: any): string {
  if (!ts) return '--:--:--';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '--:--:--';
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
  } catch {
    return '--:--:--';
  }
}

/** Format duration in ms to a human-readable string */
function formatDuration(ms: number): string {
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Component
// ============================================================================

interface LogEntryRowProps {
  entry: LogEntry;
}

function LogEntryRow({ entry }: LogEntryRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  const details = entry.details;
  const hasDetails =
    details?.command || details?.stdout || details?.stderr ||
    details?.error || details?.method || details?.input != null || details?.output != null;

  return (
    <div
      data-log-row
      className={`
        border-b border-theme-default/50 text-[11px] leading-relaxed select-text
        ${entry.level === 'error' ? 'bg-red-500/5' : ''}
        ${expanded ? 'bg-theme-surface/50' : 'hover:bg-theme-surface/30'}
      `}
    >
      {/* Summary row */}
      <button
        onClick={toggle}
        disabled={!hasDetails}
        className="w-full flex items-start gap-1.5 px-2 py-1 text-left cursor-pointer disabled:cursor-default select-text"
      >
        {/* Expand chevron */}
        <span className="shrink-0 mt-0.5 text-theme-muted w-3">
          {hasDetails ? (
            expanded ? <ChevronDown style={chevronStyle} /> : <ChevronRight style={chevronStyle} />
          ) : null}
        </span>

        {/* Timestamp */}
        <span className="shrink-0 text-theme-muted font-mono w-[80px]">
          {formatTime(entry.timestamp)}
        </span>

        {/* Level */}
        <span className={`shrink-0 font-mono w-[40px] ${levelColor(entry.level as string)}`}>
          {levelLabel(entry.level as string)}
        </span>

        {/* Category badge */}
        <span className={`shrink-0 px-1.5 py-0 rounded text-[10px] ${categoryBadge(entry.category as string)}`}>
          {entry.category}
        </span>

        {/* Message */}
        <span className="flex-1 text-theme-primary truncate min-w-0">
          {entry.message}
        </span>

        {/* Duration */}
        {entry.duration >= 0 && (
          <span className="shrink-0 text-theme-muted font-mono ml-1">
            {formatDuration(entry.duration)}
          </span>
        )}
      </button>

      {/* Expanded details panel */}
      {expanded && hasDetails && (
        <div className="mx-2 mb-2 ml-[26px] p-2 rounded bg-theme-base/60 border border-theme-default/50 font-mono text-[10px] space-y-1.5 overflow-x-auto select-text">
          {details.command && (
            <DetailField label="Command" value={`${details.command} ${(details.args || []).join(' ')}`} />
          )}
          {details.workDir && <DetailField label="WorkDir" value={details.workDir} />}
          {details.exitCode !== undefined && details.exitCode !== 0 && (
            <DetailField label="Exit Code" value={String(details.exitCode)} className="text-red-400" />
          )}
          {details.method && <DetailField label="Method" value={details.method} />}
          {details.input != null && (
            <DetailField label="Input" value={typeof details.input === 'string' ? details.input : JSON.stringify(details.input, null, 2)} pre />
          )}
          {details.output != null && (
            <DetailField label="Output" value={typeof details.output === 'string' ? details.output : JSON.stringify(details.output, null, 2)} pre />
          )}
          {details.stdout && <DetailField label="Stdout" value={details.stdout} pre />}
          {details.stderr && <DetailField label="Stderr" value={details.stderr} pre className="text-red-400" />}
          {details.error && <DetailField label="Error" value={details.error} className="text-red-400" />}
          {details.stack && <DetailField label="Stack" value={details.stack} pre />}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// DetailField — a labeled value in the expanded panel
// ============================================================================

interface DetailFieldProps {
  label: string;
  value: string;
  pre?: boolean;
  className?: string;
}

function DetailField({ label, value, pre, className = '' }: DetailFieldProps): JSX.Element {
  return (
    <div>
      <span className="text-theme-muted">{label}: </span>
      {pre ? (
        <pre className={`mt-0.5 whitespace-pre-wrap break-all ${className}`}>{value}</pre>
      ) : (
        <span className={`break-all ${className}`}>{value}</span>
      )}
    </div>
  );
}

export default memo(LogEntryRow);
