import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  InlineDiffRung,
  VirtualizedLadderDiagram,
  type LadderDiagramTheme,
  type InstructionContext,
  type NormalizedRung,
} from 'ladder-visualizer';

import { IOFABRIK_LADDER_THEME } from '../../file/l5x/theme';
import { buildRoutineDiffRenderModel, type L5XDiffRoutineRow } from './routine-render-model';
import type { L5XDiffRoutineEntity } from './types';
import { RoutineContentDiff } from './RoutineContentDiff';

const OVERSCAN_ROWS = 6;

function useMeasuredElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number | undefined] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>();

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const updateWidth = () => {
      const nextWidth = element.clientWidth;
      if (nextWidth <= 0) {
        return;
      }

      setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

function getChangeTone(kind: L5XDiffRoutineEntity['changeKind'] | L5XDiffRoutineRow['state']): string {
  switch (kind) {
    case 'added':
      return 'border-theme-added/40 bg-theme-added/10 text-theme-added';
    case 'removed':
      return 'border-theme-removed/40 bg-theme-removed/10 text-theme-removed';
    case 'modified':
      return 'border-theme-modified/40 bg-theme-modified/10 text-theme-modified';
    default:
      return 'border-theme-default bg-theme-elevated text-theme-secondary';
  }
}

function buildRoutineTheme(): LadderDiagramTheme {
  return {
    ...IOFABRIK_LADDER_THEME,
    bgPrimary: 'var(--color-ladder-diff-canvas)',
    rowEvenBg: 'var(--color-ladder-diff-canvas)',
    rowOddBg: 'var(--color-ladder-diff-canvas)',
    cellEvenBg: 'var(--color-ladder-diff-canvas)',
    cellOddBg: 'var(--color-ladder-diff-canvas)',
  };
}

function RungDiagram({
  rung,
  label,
  tone,
  height,
  theme,
  isDarkMode,
  instructionContext,
}: {
  rung: NormalizedRung;
  label: string;
  tone: 'added' | 'removed';
  height: number;
  theme: LadderDiagramTheme;
  isDarkMode: boolean;
  instructionContext: InstructionContext;
}): JSX.Element {
  const rungs = useMemo(() => [rung], [rung]);
  const toneClass = tone === 'added'
    ? 'border-theme-added/40 bg-theme-added/10'
    : 'border-theme-removed/40 bg-theme-removed/10';

  return (
    <div className={`border ${toneClass} overflow-hidden`}>
      <div className="border-b border-theme-default/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-theme-secondary">
        {label}
      </div>
      <div className={isDarkMode ? 'ladder-visualizer-dark' : ''} style={{ height }}>
        <VirtualizedLadderDiagram
          rungs={rungs}
          instructionContext={instructionContext}
          theme={theme}
          height={height}
          className="h-full"
        />
      </div>
    </div>
  );
}

function InlineDiffDiagram({
  row,
  theme,
  instructionContext,
}: {
  row: L5XDiffRoutineRow;
  theme: LadderDiagramTheme;
  instructionContext: InstructionContext;
}): JSX.Element {
  const [containerRef, containerWidth] = useMeasuredElementWidth<HTMLDivElement>();

  if (!row.inlineDiffModel) {
    return (
      <div className="rounded-md border border-dashed border-theme-default px-3 py-6 text-sm text-theme-secondary">
        Rung diff data is unavailable for this row.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="overflow-x-auto border border-theme-modified/40 bg-theme-elevated/30">
      <div className="min-w-fit">
        <InlineDiffRung model={row.inlineDiffModel} width={containerWidth} theme={theme} instructionContext={instructionContext} />
      </div>
    </div>
  );
}

const RoutineDiffRowCard = memo(function RoutineDiffRowCard({
  row,
  theme,
  isDarkMode,
  entity,
}: {
  row: L5XDiffRoutineRow;
  theme: LadderDiagramTheme;
  isDarkMode: boolean;
  entity: L5XDiffRoutineEntity;
}): JSX.Element {
  const primaryRung = row.newRung ?? row.oldRung;
  const rowToneClass = row.state === 'added'
    ? 'border-theme-added/40 bg-theme-added/5'
    : row.state === 'removed'
      ? 'border-theme-removed/40 bg-theme-removed/5'
      : 'border-theme-modified/40 bg-theme-modified/5';

  return (
    <div className={`overflow-hidden border-b ${rowToneClass}`}>
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-theme-secondary">Rung #{row.rungNumber}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${getChangeTone(row.state)}`}>
            {row.state}
          </span>
        </div>
        {row.propertyChanges.length > 0 ? (
          <span className="text-[11px] text-theme-muted">{row.propertyChanges.length} field changes</span>
        ) : null}
      </div>

      {row.propertyChanges.length > 0 ? (
        <div className="border-t border-theme-default/30 px-3 py-2 text-xs text-theme-secondary">
          <div className="flex flex-wrap gap-2">
            {row.propertyChanges.map((propertyChange) => (
              <span
                key={`${row.key}:${propertyChange.property}`}
                className="rounded border border-theme-default bg-theme-elevated px-2 py-0.5"
              >
                {propertyChange.property}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2 px-3 py-2">
        {row.separateVersions ? (
          <>
            {row.oldRung && <RungDiagram rung={row.oldRung} label="Previous version" tone="removed" height={row.measuredHeight}
              theme={theme} isDarkMode={isDarkMode} instructionContext={entity.oldInstructionContext} />}
            {row.newRung && <RungDiagram rung={row.newRung} label="Current version" tone="added" height={row.measuredHeight}
              theme={theme} isDarkMode={isDarkMode} instructionContext={entity.newInstructionContext} />}
          </>
        ) : row.state === 'modified' ? (
          <InlineDiffDiagram row={row} theme={theme} instructionContext={entity.newInstructionContext} />
        ) : primaryRung ? (
          <RungDiagram
            rung={primaryRung}
            label={row.state === 'removed' ? 'Removed' : 'Added'}
            tone={row.state === 'removed' ? 'removed' : 'added'}
            height={row.measuredHeight}
            theme={theme}
            isDarkMode={isDarkMode}
            instructionContext={row.state === 'removed' ? entity.oldInstructionContext : entity.newInstructionContext}
          />
        ) : (
          <div className="rounded-md border border-dashed border-theme-default px-3 py-6 text-sm text-theme-secondary">
            Rung data is unavailable for this row.
          </div>
        )}
      </div>
    </div>
  );
});

const RLLRoutineDiffInspector = memo(function RLLRoutineDiffInspector({
  entity,
  isDarkMode,
}: {
  entity: L5XDiffRoutineEntity;
  isDarkMode: boolean;
}): JSX.Element {
  const model = useMemo(() => buildRoutineDiffRenderModel(entity), [entity]);
  const theme = useMemo(() => buildRoutineTheme(), []);
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: model.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => model.rows[index]?.measuredHeight ?? 0,
    overscan: OVERSCAN_ROWS,
    paddingStart: 8,
    paddingEnd: 8,
    gap: 12,
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-theme-bg">
      {model.propertyChanges.length > 0 ? (
        <div className="border-b border-theme-default bg-theme-surface px-4 py-2 text-sm text-theme-secondary">
          <div className="flex flex-wrap gap-2">
            {model.propertyChanges.map((propertyChange) => (
              <span
                key={`${model.routineName}:${propertyChange.property}`}
                className="rounded border border-theme-default bg-theme-elevated px-2 py-0.5 text-xs"
              >
                {propertyChange.property}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-hidden">
        {model.rows.length === 0 ? (
          <div className="flex min-h-[240px] items-center justify-center px-4 text-sm text-theme-secondary">
            No changed rung lines are available for this routine diff.
          </div>
        ) : (
          <div ref={parentRef} className="h-full min-h-[420px] overflow-auto bg-theme-surface">
            <div
              className="relative w-full"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = model.rows[virtualRow.index];
                return (
                  <div
                    key={row.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <RoutineDiffRowCard row={row} theme={theme} isDarkMode={isDarkMode} entity={entity} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export const RoutineDiffInspector = memo(function RoutineDiffInspector({ entity, isDarkMode }: {
  entity: L5XDiffRoutineEntity; isDarkMode: boolean;
}) {
  const typeChanged = entity.oldRoutine && entity.newRoutine && entity.oldRoutine.type !== entity.newRoutine.type;
  const useRll = !typeChanged && entity.routineType === 'RLL';
  return <section aria-label={`${entity.tab.subtitle} / ${entity.routineName} comparison`} className="flex h-full min-h-0 flex-col bg-theme-surface">
    <div className="shrink-0 border-b border-theme-default px-3 py-2 text-xs text-theme-primary">
      <span className="font-medium">{entity.tab.subtitle} / {entity.routineName}</span>
      <span className="ml-3 text-theme-secondary">{entity.changeKind.charAt(0).toUpperCase() + entity.changeKind.slice(1)}</span>
      {!useRll && (entity.routineDiff.propertyChanges ?? []).map(change => <span key={change.property} className="ml-3 text-theme-secondary">
        {change.property}: {String(change.oldValue ?? '(empty)')} → {String(change.newValue ?? '(empty)')}
      </span>)}
    </div>
    <div className="min-h-0 flex-1">{useRll ? <RLLRoutineDiffInspector entity={entity} isDarkMode={isDarkMode} />
      : <RoutineContentDiff entity={entity} />}</div>
  </section>;
});
