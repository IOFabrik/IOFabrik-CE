import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Share2, X } from 'lucide-react';
import { toast } from 'sonner';

import { ICON_SIZES } from '../../../shared/constants';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
} from '../../../shared/ui';
import { useIntegrationSession } from '../../integration';
import SessionConflictResolver from '../../integration/components/SessionConflictResolver';

const iconSm = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };

interface MergeFinishModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function MergeFinishModal({ open, onOpenChange }: MergeFinishModalProps): JSX.Element {
  const {
    session,
    entries,
    isBusy,
    shareUpdate,
    cancelUpdate,
  } = useIntegrationSession();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [actionError, setActionError] = useState('');
  const previousStateRef = useRef('');

  const state = session?.state ?? '';
  const needsDecisions = state === 'needs-decisions';
  const canShare = state === 'updated';
  const canCancel = needsDecisions || state === 'failed';

  useEffect(() => {
    if (!open) {
      previousStateRef.current = state;
      return;
    }
    if (previousStateRef.current === 'needs-decisions' && state === 'updated') {
      onOpenChange(false);
    }
    previousStateRef.current = state;
  }, [open, onOpenChange, state]);

  const handleShare = useCallback(async (): Promise<void> => {
    setActionError('');
    const result = await shareUpdate();
    if (result?.success) {
      toast.success(result.message);
      onOpenChange(false);
      return;
    }
    setActionError(
      result?.error
      || result?.message
      || 'Sharing could not finish. Keep this project open, then try again.',
    );
  }, [onOpenChange, shareUpdate]);

  const handleCancelUpdate = useCallback(async (): Promise<void> => {
    setShowCancelConfirm(false);
    setActionError('');
    const result = await cancelUpdate();
    if (result?.success) {
      toast.success(result.message);
      onOpenChange(false);
      return;
    }
    setActionError(
      result?.error
      || result?.message
      || "The update wasn't cancelled. Close and reopen the project, then try again.",
    );
  }, [cancelUpdate, onOpenChange]);

  const title = needsDecisions
    ? 'Conflict Review'
    : canShare
      ? 'Share updated work?'
      : 'Update status';

  const description = needsDecisions
    ? session?.message
    : canShare
      ? 'Your work is up to date with the shared project. Confirm when you are ready to share the updated files with your team.'
      : session?.error || session?.message || 'This update is no longer active. Close this window and check the project status.';

  return (
    <>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent
          size={needsDecisions ? '6xl' : 'md'}
          className={needsDecisions ? 'h-[min(92vh,860px)] p-0 flex flex-col overflow-hidden' : undefined}
        >
          <AlertDialogHeader className={needsDecisions ? 'border-b border-theme-default px-5 py-4' : undefined}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AlertDialogTitle>{title}</AlertDialogTitle>
                  {needsDecisions && (
                    <Badge variant="warning">
                      {entries.length === 1 ? '1 file needs a decision' : `${entries.length} files need a decision`}
                    </Badge>
                  )}
                </div>
                <AlertDialogDescription className="mt-2">
                  {description}
                </AlertDialogDescription>
              </div>
              <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close">
                <X style={iconSm} />
              </Button>
            </div>
            {(actionError || session?.error) && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                <AlertTriangle style={iconSm} className="mt-0.5 shrink-0" />
                <span>{actionError || session?.error}</span>
              </div>
            )}
          </AlertDialogHeader>

          {needsDecisions && (
            <div className="flex-1 min-h-0 overflow-hidden px-5 py-4">
              <SessionConflictResolver />
            </div>
          )}

          <AlertDialogFooter className={needsDecisions ? 'border-t border-theme-default px-5 py-4' : undefined}>
            {canCancel && (
              <Button variant="outline" onClick={() => setShowCancelConfirm(true)} disabled={isBusy}>
                Cancel update
              </Button>
            )}
            <AlertDialogCancel disabled={isBusy}>Close</AlertDialogCancel>
            {canShare && (
              <Button onClick={() => void handleShare()} disabled={isBusy}>
                {isBusy ? <Loader2 style={iconSm} className="animate-spin" /> : <Share2 style={iconSm} />}
                Share updated work
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this update?</AlertDialogTitle>
            <AlertDialogDescription>
              IOFabrik will restore the project to exactly how it was before shared updates were added.
              Choices made in this review will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleCancelUpdate()}>
              Cancel update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default memo(MergeFinishModal);
