import type { PreviewNotificationState } from '../hooks/usePreviewGeneration';

/** Only the current operation's publication workspace is hidden from browsing. */
export function isActivePreviewStagingPath(path: string, notification?: PreviewNotificationState | null): boolean {
  if (!notification || notification.status === 'error') return false;
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const root = normalize(notification.repoPath);
  const source = normalize(notification.filePath);
  const staging = `${source.slice(0, source.lastIndexOf('/'))}/.iofabrik-preview-${notification.operationId}`;
  const normalized = normalize(path);
  const absolute = normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) ? normalized : `${root}/${normalized}`;
  const windows = /^[a-z]:\//i.test(root) || root.startsWith('//');
  const candidate = windows ? absolute.toLowerCase() : absolute;
  const expected = windows ? staging.toLowerCase() : staging;
  return candidate === expected || candidate.startsWith(`${expected}/`);
}
