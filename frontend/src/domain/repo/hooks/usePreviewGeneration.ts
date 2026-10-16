import { useCallback, useRef, useState } from 'react';
import { GeneratePreview } from '../services/repo-commands';
import { onEvent } from '../../../shared/runtime/events';

export interface PreviewNotificationState {
  operationId: string;
  startedAt: number;
  filePath: string;
  repoPath: string;
  status: 'running' | 'success' | 'error';
  message: string;
}

type OperationLock = <T>(label: string, operation: () => Promise<T>) => Promise<T | null>;

export function usePreviewGeneration(repoPath: string | null, withOperationLock: OperationLock, refreshAll: () => Promise<void>) {
  const [previewNotification, setPreviewNotification] = useState<PreviewNotificationState | null>(null);
  const previewRunningRef = useRef(false);
  const dismissPreviewNotification = useCallback(() => {
    setPreviewNotification(current => current?.status === 'running' ? current : null);
  }, []);

  const generatePreview = useCallback(async (filePath: string): Promise<boolean> => {
    if (!repoPath) return false;
    const result = await withOperationLock('Generating preview', async () => {
      const operationId = crypto.randomUUID();
      const initial: PreviewNotificationState = {
        operationId, startedAt: Date.now(), repoPath, filePath, status: 'running', message: 'Checking the project and preview tools…',
      };
      previewRunningRef.current = true;
      setPreviewNotification(initial);
      // Subscribe before invoking the backend, including fast validation failures.
      const unsubscribe = onEvent('preview-progress', ({ data }: { data: { operationId: string; message?: string } }) => {
        if (data.operationId !== operationId || !data.message) return;
        setPreviewNotification(current => current?.operationId === operationId && current.status === 'running'
          ? { ...current, message: data.message! } : current);
      });
      let success = false;
      let message = 'The preview did not finish. Reopen the app, check the SDK installation, then try again.';
      try {
        const generated = await GeneratePreview(repoPath, filePath, operationId);
        success = generated.success;
        message = success ? 'The preview is ready.' : generated.error || 'Check the selected ACD and try generating the preview again.';
      } catch {
        // An unconfirmed SDK result must retain the recovery guidance above.
      } finally {
        unsubscribe();
        setPreviewNotification(current => current ? { ...current, message: 'Refreshing project files…' } : current);
        try {
          await refreshAll();
        } catch {
          message = success ? 'The preview was generated, but the project could not refresh. Refresh the project to see it.' : message;
          success = false;
        }
        previewRunningRef.current = false;
        setPreviewNotification({ ...initial, status: success ? 'success' : 'error', message });
      }
      return success;
    });
    return result ?? false;
  }, [repoPath, withOperationLock, refreshAll]);

  return { previewNotification, dismissPreviewNotification, generatePreview, previewRunningRef };
}
