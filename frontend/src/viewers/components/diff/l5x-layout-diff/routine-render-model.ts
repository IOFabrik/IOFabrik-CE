import {
  buildInlineDiffModel,
  buildInlineDiffRungLayout,
  calculateInlineDiffRungMinWidth,
  calculateMinDiagramWidth,
  calculateRungLayouts,
  RAIL_VISUAL_WIDTH,
  valuesEqual,
  MIN_RUNG_HEIGHT,
  type InlineDiffRungModel,
  type InstructionContext,
  type NormalizedRung,
  type PropertyChange,
} from 'ladder-visualizer';

import type { L5XDiffRoutineEntity } from './types';

export type L5XDiffRoutineRowState = 'added' | 'removed' | 'modified';

export interface L5XDiffRoutineRow {
  key: string;
  rungNumber: number;
  state: L5XDiffRoutineRowState;
  measuredHeight: number;
  oldRung?: NormalizedRung;
  newRung?: NormalizedRung;
  inlineDiffModel?: InlineDiffRungModel;
  separateVersions?: boolean;
  propertyChanges: PropertyChange[];
}

export interface L5XDiffRoutineRenderModel {
  changeKind: L5XDiffRoutineEntity['changeKind'];
  ownerName: string;
  routineName: string;
  rows: L5XDiffRoutineRow[];
  propertyChanges: PropertyChange[];
  counts: Record<'unchanged' | L5XDiffRoutineRowState, number>;
}

function getRungIdentity(rung: NormalizedRung, fallbackIndex: number): number {
  return Number.isFinite(rung.number) ? rung.number : fallbackIndex;
}

function buildRungMap(rungs: NormalizedRung[] | undefined): Map<number, NormalizedRung> {
  const map = new Map<number, NormalizedRung>();

  for (const [index, rung] of (rungs ?? []).entries()) {
    map.set(getRungIdentity(rung, index), rung);
  }

  return map;
}

function getMeasuredRoutineDiffRowHeight(
  state: L5XDiffRoutineRowState,
  oldRung: NormalizedRung | undefined,
  newRung: NormalizedRung | undefined,
  inlineDiffModel: InlineDiffRungModel | undefined,
  instructionContext: InstructionContext,
): number {
  if (state === 'modified') {
    return inlineDiffModel
      ? buildInlineDiffRungLayout(inlineDiffModel, {
          rightRailX: calculateInlineDiffRungMinWidth(inlineDiffModel, instructionContext) - RAIL_VISUAL_WIDTH,
          instructionContext,
        }).height
      : MIN_RUNG_HEIGHT;
  }

  const rung = newRung ?? oldRung;
  return rung
    ? calculateRungLayouts([rung], calculateMinDiagramWidth([rung], instructionContext), instructionContext)[0]?.height ?? MIN_RUNG_HEIGHT
    : MIN_RUNG_HEIGHT;
}

export function buildRoutineDiffRenderModel(entity: L5XDiffRoutineEntity): L5XDiffRoutineRenderModel {
  const oldRungs = buildRungMap(entity.oldRoutine?.rungs);
  const newRungs = buildRungMap(entity.newRoutine?.rungs);
  const rungDiffs = new Map(
    (entity.routineDiff.rungDiffs ?? []).map((rungDiff) => [rungDiff.rungNumber, rungDiff] as const),
  );

  const rungNumbers = new Set<number>([
    ...oldRungs.keys(),
    ...newRungs.keys(),
    ...rungDiffs.keys(),
  ]);

  const counts: Record<L5XDiffRoutineRowState, number> = {
    added: 0,
    removed: 0,
    modified: 0,
  };
  let unchangedCount = 0;

  const rows: L5XDiffRoutineRow[] = [];

  for (const rungNumber of [...rungNumbers].sort((left, right) => left - right)) {
    const rungDiff = rungDiffs.get(rungNumber);
    const oldRung = rungDiff ? rungDiff.oldRung : oldRungs.get(rungNumber);
    const newRung = rungDiff ? rungDiff.newRung : newRungs.get(rungNumber);

    if (rungDiff) {
      const inlineDiffModel = rungDiff.kind === 'modified'
        ? buildInlineDiffModel({
            oldRung,
            newRung,
            rungNumber,
          })
        : undefined;
      // InlineDiffRung accepts one context. Separate versions preserve labels when AOI definitions differ.
      const separateVersions = rungDiff.kind === 'modified' && [...(oldRung?.instructions ?? []), ...(newRung?.instructions ?? [])]
        .some(instruction => !valuesEqual(entity.oldInstructionContext.instructionRegistry.get(instruction.mnemonic),
          entity.newInstructionContext.instructionRegistry.get(instruction.mnemonic)));
      const row = {
        separateVersions,
        key: `${entity.semanticId}:rung:${rungNumber}`,
        rungNumber,
        state: rungDiff.kind,
        measuredHeight: separateVersions
          ? Math.max(getMeasuredRoutineDiffRowHeight('removed', oldRung, undefined, undefined, entity.oldInstructionContext),
            getMeasuredRoutineDiffRowHeight('added', undefined, newRung, undefined, entity.newInstructionContext))
          : getMeasuredRoutineDiffRowHeight(rungDiff.kind, oldRung, newRung, inlineDiffModel,
            rungDiff.kind === 'removed' ? entity.oldInstructionContext : entity.newInstructionContext),
        oldRung,
        newRung,
        inlineDiffModel,
        propertyChanges: rungDiff.propertyChanges ?? [],
      } satisfies L5XDiffRoutineRow;
      counts[row.state] += 1;
      rows.push(row);
    } else if (entity.changeKind === 'added' && newRung && !oldRung) {
      const row = {
        key: `${entity.semanticId}:rung:${rungNumber}`,
        rungNumber,
        state: 'added',
        measuredHeight: getMeasuredRoutineDiffRowHeight('added', oldRung, newRung, undefined, entity.newInstructionContext),
        oldRung,
        newRung,
        propertyChanges: [],
      } satisfies L5XDiffRoutineRow;
      counts.added += 1;
      rows.push(row);
    } else if (entity.changeKind === 'removed' && oldRung && !newRung) {
      const row = {
        key: `${entity.semanticId}:rung:${rungNumber}`,
        rungNumber,
        state: 'removed',
        measuredHeight: getMeasuredRoutineDiffRowHeight('removed', oldRung, newRung, undefined, entity.oldInstructionContext),
        oldRung,
        newRung,
        propertyChanges: [],
      } satisfies L5XDiffRoutineRow;
      counts.removed += 1;
      rows.push(row);
    } else {
      unchangedCount += 1;
    }
  }

  return {
    changeKind: entity.changeKind,
    ownerName: entity.ownerName,
    routineName: entity.routineName,
    rows,
    propertyChanges: entity.routineDiff.propertyChanges ?? [],
    counts: {
      unchanged: unchangedCount,
      ...counts,
    },
  };
}