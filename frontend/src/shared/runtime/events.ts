/**
 * Typed wrapper around Wails runtime Events.
 *
 * Centralises all backend→frontend event subscriptions so that:
 * 1. Event names are defined in one place (no magic strings scattered).
 * 2. Payload types are documented and enforced at call sites.
 * 3. Swapping the event transport in future requires editing only this file.
 *
 * Usage:
 *   import { onEvent, AppEvent } from '../../shared/runtime/events';
 *   const cancel = onEvent('files-changed', () => refresh());
 *   return () => cancel();
 */
import { Events } from '@wailsio/runtime';

// ---------------------------------------------------------------------------
// Known application events (backend → frontend)
// ---------------------------------------------------------------------------

/**
 * Union of all event names emitted by the Go backend.
 * Add new events here as they are introduced.
 */
export type AppEvent =
  | 'files-changed'
  | 'folder-selected'
  | 'folder-closed'
  | 'file:reveal-in-finder'
  | 'file:open-in-terminal'
  | 'git-progress'
  | 'preview-progress'
  | 'local-bin:progress'
  | 'debug:new-log'
  | 'debug:state-changed'
  | 'background-task-completed'
  | 'conflictQueue:changed'
  | 'integrationSession:changed'
  | 'integrationSession:conflicts';

// ---------------------------------------------------------------------------
// Subscription helper
// ---------------------------------------------------------------------------

type CancelFn = () => void;

/**
 * Subscribe to a Wails backend event.
 *
 * Returns an unsubscribe function — call it in your useEffect cleanup.
 *
 * @param event   - One of the known `AppEvent` names.
 * @param handler - Callback invoked when the event fires.
 *
 * @example
 *   useEffect(() => {
 *     const cancel = onEvent('files-changed', () => refreshStatus());
 *     return () => cancel();
 *   }, []);
 */
export function onEvent(event: AppEvent, handler: (...args: any[]) => void): CancelFn {
  return Events.On(event, handler);
}
