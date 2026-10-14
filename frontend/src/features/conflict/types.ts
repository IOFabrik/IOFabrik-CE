import type {
  ConflictBlob as GeneratedConflictBlob,
  ConflictRegionView as GeneratedConflictRegionView,
  ConflictResolutionData as GeneratedConflictResolutionData,
} from '../../../bindings/iofabrik/services/models';

export type ConflictFileStatus =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'deleted-by-us'
  | 'deleted-by-them';

export type ConflictIneligibleReason =
  | ''
  | 'unsafe-file-type'
  | 'missing-side'
  | 'file-too-large'
  | 'binary-content'
  | 'unsupported-encoding'
  | 'unsupported-content'
  | 'line-ending-mismatch'
  | 'conflict-generation-failed'
  | 'output-too-large';

/** Stage metadata only. Blob contents stay in the Go service. */
export interface ConflictBlob {
  present: boolean;
  oid?: string;
  mode?: string;
}

export interface ConflictRegion {
  id: string;
  current: string[];
  base: string[];
  incoming: string[];
  contextBefore: string;
  contextAfter: string;
}

export type ConflictSide = 'current' | 'incoming';

export interface ConflictLineChoice {
  current: boolean[];
  incoming: boolean[];
}

export type ConflictRegionDecision =
  | { mode: 'unresolved' }
  | { mode: 'block'; side: ConflictSide }
  | { mode: 'lines'; lines: ConflictLineChoice }
  | { mode: 'remove' };

export interface TextConflictDraft {
  path: string;
  resolutionToken: string;
  decisions: Record<string, ConflictRegionDecision>;
}

export interface ConflictResolutionData {
  success: boolean;
  path: string;
  status: ConflictFileStatus;
  eligible: boolean;
  ineligibleReason?: ConflictIneligibleReason;
  base: ConflictBlob;
  current: ConflictBlob;
  incoming: ConflictBlob;
  regions: ConflictRegion[];
  resolutionToken?: string;
  newline?: string;
  hasFinalNewline: boolean;
  error?: string;
}

const mapConflictBlob = (blob: GeneratedConflictBlob): ConflictBlob => ({
  present: blob.present,
  oid: blob.oid,
  mode: blob.mode,
});

const mapConflictRegion = (region: GeneratedConflictRegionView): ConflictRegion => ({
  id: region.id,
  current: [...region.current],
  base: [...(region.base ?? [])],
  incoming: [...region.incoming],
  contextBefore: region.contextBefore ?? '',
  contextAfter: region.contextAfter ?? '',
});

export const mapConflictResolutionData = (
  data: GeneratedConflictResolutionData,
): ConflictResolutionData => ({
  success: data.success,
  path: data.path,
  status: data.status as ConflictFileStatus,
  eligible: data.eligible,
  ineligibleReason: data.ineligibleReason as ConflictIneligibleReason | undefined,
  base: mapConflictBlob(data.base),
  current: mapConflictBlob(data.current),
  incoming: mapConflictBlob(data.incoming),
  regions: (data.regions ?? []).map(mapConflictRegion),
  resolutionToken: data.resolutionToken,
  newline: data.newline,
  hasFinalNewline: data.hasFinalNewline,
  error: data.error,
});

/**
 * Serializes draft decisions for the Go composer. Regions left unresolved are
 * omitted so the service reports them as undecided.
 */
export const toConflictDecisionPayload = (
  decisions: Record<string, ConflictRegionDecision>,
): Array<{
  regionId: string;
  mode: string;
  side?: string;
  currentLines?: boolean[];
  incomingLines?: boolean[];
}> => Object.entries(decisions).flatMap(([regionId, decision]) => {
  switch (decision.mode) {
    case 'block':
      return [{ regionId, mode: 'block', side: decision.side }];
    case 'lines':
      return [{
        regionId,
        mode: 'lines',
        currentLines: [...decision.lines.current],
        incomingLines: [...decision.lines.incoming],
      }];
    case 'remove':
      return [{ regionId, mode: 'remove' }];
    default:
      return [];
  }
});

/** True when every region has a usable choice, without composing the file. */
export const areConflictDecisionsComplete = (
  regions: ConflictRegion[],
  decisions: Record<string, ConflictRegionDecision>,
): boolean => regions.every((region) => isDecisionUsable(region, decisions[region.id]));

export const isDecisionUsable = (
  region: ConflictRegion,
  decision?: ConflictRegionDecision,
): boolean => {
  if (!decision) {
    return false;
  }

  switch (decision.mode) {
    case 'block':
      return decision.side === 'current' || decision.side === 'incoming';
    case 'lines':
      return decision.lines.current.length === region.current.length
        && decision.lines.incoming.length === region.incoming.length
        && (decision.lines.current.some(Boolean) || decision.lines.incoming.some(Boolean));
    case 'remove':
      return true;
    default:
      return false;
  }
};
