import { memo } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui';
import type { LFSAutoTrackCandidate } from '../../../domain/repo/services/lfs-auto-track';

interface LFSAutoTrackModalProps {
  open: boolean;
  candidates: LFSAutoTrackCandidate[];
  selectedFilePaths: Set<string>;
  isApplying: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleFile: (filePath: string) => void;
  onToggleSelectAll: () => void;
  onConfirm: () => void;
}

function LFSAutoTrackModal({
  open,
  candidates,
  selectedFilePaths,
  isApplying,
  onOpenChange,
  onToggleFile,
  onToggleSelectAll,
  onConfirm,
}: LFSAutoTrackModalProps): JSX.Element {
  const allSelected = candidates.length > 0 && selectedFilePaths.size === candidates.length;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>IOFabrik can remember these file types for Large File Storage</AlertDialogTitle>
          <AlertDialogDescription>
            These files look like large or non-human readable formats. Using Large File Storage (LFS) can improve git performance.
            Select files which you want to store with LFS.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 bg-theme-surface/40 p-3">
          <label className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-theme-secondary cursor-pointer select-none hover:bg-theme-elevated/70">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleSelectAll}
              disabled={isApplying || candidates.length === 0}
            />
            <span>Remember all</span>
          </label>

          <div className="max-h-64 overflow-auto rounded-md border border-theme-default bg-theme-surface p-1">
            {candidates.map((candidate) => {
              const checked = selectedFilePaths.has(candidate.filePath);
              return (
                <label
                  key={candidate.filePath}
                  className="flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer hover:bg-theme-elevated"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleFile(candidate.filePath)}
                    disabled={isApplying}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-theme-primary truncate" title={candidate.filePath}>
                      {candidate.filePath}
                    </div>
                    <div className="text-xs text-theme-muted">
                      This app will remember: {candidate.pattern}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isApplying}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="default"
            onClick={onConfirm}
            disabled={isApplying}
          >
            {isApplying ? 'Working…' : 'Remember & Save'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default memo(LFSAutoTrackModal);
