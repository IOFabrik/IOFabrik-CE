/**
 * Presentation helpers for the conflict queue.
 *
 * The backend speaks git; the sidebar speaks the app's plain-language
 * vocabulary. Every mapping from a backend enum to user-facing text lives here
 * so the sidebar, and any future conflict surface, share one wording source.
 */
import {
  ConflictEligibility,
  ConflictKind,
  ConflictState,
  type ConflictQueueEntry,
} from '../../../../bindings/iofabrik/services/models';
import { getFolderNameFromPath } from '../../../shared/utils/gitHelpers';

const UNKNOWN_KIND_LABEL = 'This file needs a decision';
const UNKNOWN_REASON_LABEL = "This file can't be resolved in the app";

const CONFLICT_KIND_LABELS: Partial<Record<ConflictKind, string>> = {
  [ConflictKind.ConflictKindBothModified]: 'Both changed this file',
  [ConflictKind.ConflictKindBothAdded]: 'Both added this file',
  [ConflictKind.ConflictKindAddedByUs]: 'Only you added this file',
  [ConflictKind.ConflictKindAddedByThem]: 'Only they added this file',
  [ConflictKind.ConflictKindDeletedByUs]: 'You deleted it, they changed it',
  [ConflictKind.ConflictKindDeletedByThem]: 'They deleted it, you changed it',
  [ConflictKind.ConflictKindBothDeleted]: 'Both deleted this file',
};

const INELIGIBLE_REASON_LABELS: Record<string, string> = {
  image: 'Image files are compared side by side',
  binary: "This file can't be shown as text",
  'too-large': 'This file is too large to open here',
  submodule: "This file type can't be resolved in the app",
  symlink: "This file type can't be resolved in the app",
  'unsupported-mode': "This file type can't be resolved in the app",
  'not-utf8': 'This file uses an unsupported text encoding',
  'one-sided': 'One side deleted this file',
};

/** Filename shown in the row. The full path lives in the tooltip. */
export function getConflictFileName(entry: ConflictQueueEntry): string {
  return getFolderNameFromPath(entry.path);
}

/** True when the in-app resolver can present this file directly. */
export function isConflictEntryResolvable(entry: ConflictQueueEntry): boolean {
  return entry.eligibility === ConflictEligibility.ConflictEligible;
}

/** True when the conflict has not happened yet and is waiting on a merge. */
export function isPredictedConflict(entry: ConflictQueueEntry): boolean {
  return entry.state === ConflictState.ConflictStatePredicted;
}

/**
 * One-line explanation of why upcoming conflicts are listed at all.
 *
 * Hedged deliberately: the prediction compares saved work against the target
 * branch as of the last sync, so unsaved edits and a teammate's newer work are
 * both invisible to it.
 */
export function getPredictedConflictHint(targetBranch: string | null): string {
  return targetBranch
    ? `Based on your last sync, these files will likely need a decision when you merge into ${targetBranch}.`
    : 'Based on your last sync, these files will likely need a decision when you merge.';
}

export function getConflictKindLabel(entry: ConflictQueueEntry): string {
  return CONFLICT_KIND_LABELS[entry.kind] ?? UNKNOWN_KIND_LABEL;
}

export function getConflictIneligibleLabel(entry: ConflictQueueEntry): string | null {
  if (isConflictEntryResolvable(entry)) {
    return null;
  }
  return INELIGIBLE_REASON_LABELS[entry.ineligibleReason ?? ''] ?? UNKNOWN_REASON_LABEL;
}

/**
 * Full tooltip text: what happened, any limitation, and the path — since the
 * row itself shows the filename only.
 */
export function getConflictTooltip(entry: ConflictQueueEntry, targetBranch: string | null): string {
  return [
    getConflictKindLabel(entry),
    isPredictedConflict(entry) ? getPredictedConflictHint(targetBranch) : null,
    getConflictIneligibleLabel(entry),
    entry.path,
  ]
    .filter(Boolean)
    .join('\n');
}
