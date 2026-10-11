/**
 * StatsBar - Footer for the Debug view showing entry counts, error count,
 * and export/clear action buttons.
 */
import { memo } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { ICON_SIZES } from '../../../shared/constants';
import { Button } from '../../../shared/ui';
import type { DebugStats } from '../../../../bindings/iofabrik/services/models';

interface StatsBarProps {
  stats: DebugStats;
  onExport: () => void;
  onClear: () => void;
  isExporting: boolean;
}

const iconSize = ICON_SIZES.xs;

function StatsBar({ stats, onExport, onClear, isExporting }: StatsBarProps): JSX.Element {
  return (
    <div className="flex items-center justify-between px-2 py-1.5 border-t border-theme-default shrink-0 text-[11px]">
      {/* Left: stats */}
      <div className="flex items-center gap-3 text-theme-muted">
        <span>{stats.totalEntries.toLocaleString()} entries</span>
        {stats.totalErrors > 0 && (
          <span className="text-red-400">{stats.totalErrors.toLocaleString()} errors</span>
        )}
        <span className="text-theme-muted/60">{stats.bufferUsage}% buffer</span>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-1">
        <Button
          onClick={onExport}
          disabled={isExporting || stats.totalEntries === 0}
          loading={isExporting}
          size="sm"
          title="Export logs to JSON file"
        >
          <Download size={iconSize} />
          <span>{isExporting ? 'Exporting…' : 'Export'}</span>
        </Button>
        <button
          onClick={onClear}
          disabled={stats.totalEntries === 0}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-theme-muted
                     hover:text-red-400 hover:bg-red-500/10
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Clear all log entries"
        >
          <Trash2 size={iconSize} />
          <span>Clear</span>
        </button>
      </div>
    </div>
  );
}

export default memo(StatsBar);
