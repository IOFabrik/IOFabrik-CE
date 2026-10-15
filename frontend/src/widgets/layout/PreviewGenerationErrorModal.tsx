import { memo, useCallback } from 'react';
import { useRepo } from '../../context';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, Button,
} from '../../shared/ui';

function PreviewGenerationErrorModal(): JSX.Element | null {
  const { previewError, dismissPreviewError } = useRepo();
  const close = useCallback((open: boolean) => { if (!open) dismissPreviewError(); }, [dismissPreviewError]);
  if (!previewError) return null;
  return (
    <AlertDialog open onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Preview could not be generated</AlertDialogTitle>
          <AlertDialogDescription>{previewError}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={dismissPreviewError}>Close</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default memo(PreviewGenerationErrorModal);
