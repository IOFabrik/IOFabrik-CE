/**
 * Sidebar section listing files that need a conflict decision.
 *
 * It covers both conflicts a merge has already produced and the ones the next
 * merge will produce, so a file that clashes with the target branch is visible
 * before the user starts merging rather than only once they are mid-merge.
 */
import { memo } from 'react';
import { AlertTriangle } from 'lucide-react';

import { ICON_SIZES } from '../../../../shared/constants';
import { TooltipProvider } from '../../../../shared/ui';
import type { ConflictQueueEntry } from '../../../../../bindings/iofabrik/services/models';
import { useConflictQueue } from '../../context/ConflictQueueContext';
import { getPredictedConflictHint } from '../../lib/conflict-queue-presentation';
import ConflictQueueRow from './ConflictQueueRow';

interface ConflictQueueSectionProps {
  onSelectFile: (entry: ConflictQueueEntry) => void;
}

function ConflictQueueSection({ onSelectFile }: ConflictQueueSectionProps): JSX.Element | null {
  const { entries, targetBranch, error, isEmpty } = useConflictQueue();

  if (isEmpty) {
    return null;
  }

  // The backend guarantees a snapshot is either all active or all predicted.
  const isUpcoming = targetBranch !== null;

  return (
    <section
      className="shrink-0 max-h-[40%] flex flex-col border-t border-theme-default"
      aria-label="Conflicts"
    >
      <header className="px-3 py-2 border-b border-theme-default shrink-0 flex items-center gap-2">
        <AlertTriangle
          style={{ width: ICON_SIZES.xs, height: ICON_SIZES.xs }}
          className="shrink-0 text-theme-warning"
          aria-hidden="true"
        />
        <h3 className="text-theme-muted text-xs font-sans font-medium tracking-wide">
          Conflicts ({entries.length})
        </h3>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <p className="px-3 py-2 text-xs text-theme-warning">
            This list may be out of date. Try again after your next action.
          </p>
        ) : null}
        {isUpcoming ? (
          <p className="px-3 pt-2 text-xs text-theme-muted">
            {getPredictedConflictHint(targetBranch)}
          </p>
        ) : null}
        <TooltipProvider delayDuration={300}>
          <ul>
            {entries.map((entry) => (
              <li key={entry.path}>
                <ConflictQueueRow
                  entry={entry}
                  targetBranch={targetBranch}
                  onSelect={onSelectFile}
                />
              </li>
            ))}
          </ul>
        </TooltipProvider>
      </div>
    </section>
  );
}

export default memo(ConflictQueueSection);
