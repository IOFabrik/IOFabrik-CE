import { memo, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { useRepo } from '../../context';
import { Button } from '../../shared/ui';
import Spinner from '../../shared/ui/Spinner';
import { ICON_SIZES } from '../../shared/constants';

const ESTIMATED_SECONDS = 45;
const RING_CIRCUMFERENCE = 2 * Math.PI * 20;

function PreviewCountdown({ startedAt }: { startedAt: number }): JSX.Element {
  const remaining = () => Math.max(0, Math.min(ESTIMATED_SECONDS, Math.ceil((startedAt + ESTIMATED_SECONDS * 1000 - Date.now()) / 1000)));
  const [seconds, setSeconds] = useState(remaining);

  useEffect(() => {
    const update = () => setSeconds(Math.max(0, Math.min(ESTIMATED_SECONDS, Math.ceil((startedAt + ESTIMATED_SECONDS * 1000 - Date.now()) / 1000))));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  // This estimate never completes the operation or releases its action lock.
  if (seconds === 0) return (
    <div role="img" aria-label="Taking longer than estimated; still generating preview" className="flex h-12 w-12 shrink-0 items-center justify-center text-theme-secondary">
      <Spinner size={ICON_SIZES.lg} />
    </div>
  );

  return (
    <div role="img" aria-label={`Estimated time remaining: ${seconds} seconds`} className="shrink-0 text-center text-theme-secondary">
      <div className="relative h-12 w-12" aria-hidden="true">
        <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90 fill-none" focusable="false">
          <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="3" opacity="0.15" />
          <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={RING_CIRCUMFERENCE * (1 - seconds / ESTIMATED_SECONDS)} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium tabular-nums">{seconds}s</span>
      </div>
      <span aria-hidden="true" className="text-xs text-theme-muted">est.</span>
    </div>
  );
}

export function PreviewGenerationNotification(): JSX.Element | null {
  const { previewNotification: notification, dismissPreviewNotification } = useRepo();
  useEffect(() => {
    if (notification?.status !== 'success') return;
    const timer = setTimeout(dismissPreviewNotification, 5000);
    return () => clearTimeout(timer);
  }, [notification?.operationId, notification?.status, dismissPreviewNotification]);

  if (!notification) return null;
  const running = notification.status === 'running';
  const failed = notification.status === 'error';
  const fileName = notification.filePath.split(/[\\/]/).pop();

  return (
    <section aria-label="Preview generation" className="fixed bottom-6 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border border-theme-default bg-theme-surface p-4 shadow-xl">
      {running && <PreviewCountdown key={notification.operationId} startedAt={notification.startedAt} />}
      <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1">
        <div className={`flex items-center gap-2 font-medium text-theme-primary ${running ? '' : 'pr-6'}`}>
          {!running && (failed
            ? <CircleAlert size={ICON_SIZES.md} className="shrink-0 text-red-500" />
            : <CheckCircle2 size={ICON_SIZES.md} className="shrink-0 text-green-600" />)}
          <span>{running ? 'Generating preview' : failed ? 'Preview failed' : 'Preview ready'}</span>
        </div>
        <p className="mt-1 truncate text-sm text-theme-secondary" title={notification.filePath}>{fileName}</p>
        {failed && <p className="mt-2 max-h-40 overflow-auto break-words text-sm text-theme-secondary">{notification.message}</p>}
      </div>
      {!running && (
        <Button variant="ghost" size="icon" className="absolute right-2 top-2" aria-label="Dismiss preview notification" onClick={dismissPreviewNotification}>
          <X size={ICON_SIZES.sm} />
        </Button>
      )}
    </section>
  );
}

export default memo(PreviewGenerationNotification);
