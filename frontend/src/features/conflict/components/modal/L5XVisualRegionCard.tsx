import { Check } from 'lucide-react';
import { useMemo } from 'react';
import type { NormalizedRung, NormalizedTag, STLine, VisualConflictKind, VisualConflictRegion } from 'ladder-visualizer';
import { VirtualizedLadderDiagram, measureRoutineDiffRowHeight } from 'ladder-visualizer';

import { useLayout } from '../../../../context/LayoutContext';
import { IOFABRIK_LADDER_THEME } from '../../../../viewers/components/file/l5x/theme';
import type { ConflictRegionDecision, ConflictSide } from '../../types';

// Cap tall rungs so a single preview never dominates the resolver; taller rungs scroll internally.
const MAX_RUNG_PREVIEW_HEIGHT = 320;

interface L5XVisualRegionCardProps {
  regionId: string;
  region: VisualConflictRegion;
  decision: ConflictRegionDecision;
  disabled: boolean;
  onDecision: (decision: ConflictRegionDecision) => void;
}

const KIND_LABELS: Record<VisualConflictKind, string> = {
  ladder: 'Rung',
  'structured-text': 'Structured text line',
  tag: 'Tag',
};

function L5XVisualRegionCard({
  regionId,
  region,
  decision,
  disabled,
  onDecision,
}: L5XVisualRegionCardProps): JSX.Element {
  const selectedSide = decision.mode === 'block' ? decision.side : undefined;
  const kindLabel = KIND_LABELS[region.kind];
  const radioName = `l5x-conflict-${regionId}`;

  const { theme } = useLayout();
  const isDarkMode = useMemo(() => {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  }, [theme]);

  return (
    <section className="rounded-lg border border-theme-default bg-theme-base/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-theme-primary">Choose one version of this {kindLabel.toLowerCase()}</h4>
          <p className="mt-1 text-xs text-theme-muted">The whole section is replaced by the version you pick.</p>
        </div>
        {selectedSide && (
          <span className="inline-flex items-center gap-1 text-xs text-green-400">
            <Check className="h-3.5 w-3.5" />
            {selectedSide === 'current' ? 'Current selected' : 'Incoming selected'}
          </span>
        )}
      </div>

      <div className="space-y-3">
        {(['current', 'incoming'] as const).map((side) => (
          <SideRow
            key={side}
            side={side}
            radioName={radioName}
            kind={region.kind}
            preview={region[side]}
            selected={selectedSide === side}
            disabled={disabled}
            isDarkMode={isDarkMode}
            onSelect={() => onDecision({ mode: 'block', side })}
          />
        ))}
      </div>
    </section>
  );
}

interface SideRowProps {
  side: ConflictSide;
  radioName: string;
  kind: VisualConflictKind;
  preview: NormalizedRung | NormalizedTag | STLine;
  selected: boolean;
  disabled: boolean;
  isDarkMode: boolean;
  onSelect: () => void;
}

function SideRow({ side, radioName, kind, preview, selected, disabled, isDarkMode, onSelect }: SideRowProps): JSX.Element {
  const isCurrent = side === 'current';
  const label = isCurrent ? 'Use Current' : 'Use Incoming';
  const accentBorder = selected
    ? isCurrent
      ? 'border-blue-400 bg-blue-500/10'
      : 'border-amber-400 bg-amber-500/10'
    : isCurrent
      ? 'border-blue-500/30 hover:bg-blue-500/5'
      : 'border-amber-500/30 hover:bg-amber-500/5';

  return (
    <label
      className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-md border p-3 transition-colors ${accentBorder} ${
        disabled ? 'cursor-not-allowed opacity-60' : ''
      }`}
    >
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name={radioName}
          checked={selected}
          disabled={disabled}
          onChange={onSelect}
          aria-label={label}
          className="h-4 w-4 shrink-0"
          style={{ accentColor: 'var(--color-accent-primary)' }}
        />
        <span className="text-sm font-medium text-theme-primary">{label}</span>
      </span>
      <PreviewBody kind={kind} preview={preview} isDarkMode={isDarkMode} />
    </label>
  );
}

function PreviewBody({
  kind,
  preview,
  isDarkMode,
}: {
  kind: VisualConflictKind;
  preview: NormalizedRung | NormalizedTag | STLine;
  isDarkMode: boolean;
}): JSX.Element {
  if (kind === 'ladder') {
    return <RungPreview rung={preview as NormalizedRung} isDarkMode={isDarkMode} />;
  }
  if (kind === 'structured-text') {
    return <STPreview line={preview as STLine} />;
  }
  return <TagPreview tag={preview as NormalizedTag} />;
}

function RungPreview({ rung, isDarkMode }: { rung: NormalizedRung; isDarkMode: boolean }): JSX.Element {
  // The diagram renders the rung comment itself, so height is measured with the library helper.
  const height = useMemo(
    () => Math.min(measureRoutineDiffRowHeight({ state: 'added', rung }), MAX_RUNG_PREVIEW_HEIGHT),
    [rung],
  );

  return (
    <div
      className={`min-w-0 overflow-hidden rounded border border-theme-default bg-theme-base ${isDarkMode ? 'ladder-visualizer-dark' : ''}`}
      style={{ height }}
    >
      <VirtualizedLadderDiagram
        rungs={[rung]}
        theme={IOFABRIK_LADDER_THEME}
        height={height}
        className="h-full w-full"
      />
    </div>
  );
}

function STPreview({ line }: { line: STLine }): JSX.Element {
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-theme-default bg-theme-base p-3 font-mono text-xs text-theme-secondary">
      {line.text || '(empty line)'}
    </pre>
  );
}

function TagPreview({ tag }: { tag: NormalizedTag }): JSX.Element {
  const rows: Array<[string, string | undefined]> = [
    ['Name', tag.name],
    ['Data type', tag.dataType],
    ['Type', tag.tagType],
    ['Scope', tag.scope],
    ['Alias for', tag.aliasFor],
    ['Radix', tag.radix],
    ['External access', tag.externalAccess],
    ['Description', tag.description],
  ];

  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 rounded border border-theme-default bg-theme-base p-3 text-xs">
      {rows.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-theme-muted">{label}</dt>
          <dd className="break-words font-mono text-theme-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default L5XVisualRegionCard;
