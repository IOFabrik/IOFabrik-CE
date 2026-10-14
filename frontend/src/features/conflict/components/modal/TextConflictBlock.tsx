import { Check, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

import { Button } from '../../../../shared/ui';
import type {
  ConflictRegion,
  ConflictRegionDecision,
  ConflictSide,
} from '../../types';

interface TextConflictBlockProps {
  region: ConflictRegion;
  decision: ConflictRegionDecision;
  newline: string;
  disabled: boolean;
  expanded: boolean;
  onDecision: (decision: ConflictRegionDecision) => void;
  onExpandedChange: (expanded: boolean) => void;
  onRequestRemove: () => void;
}

function createLineDecision(
  region: ConflictRegion,
  decision: ConflictRegionDecision,
): ConflictRegionDecision {
  if (decision.mode === 'lines') {
    return decision;
  }

  return {
    mode: 'lines',
    lines: {
      current: region.current.map(() => decision.mode === 'block' && decision.side === 'current'),
      incoming: region.incoming.map(() => decision.mode === 'block' && decision.side === 'incoming'),
    },
  };
}

function TextConflictBlock({
  region,
  decision,
  newline,
  disabled,
  expanded,
  onDecision,
  onExpandedChange,
  onRequestRemove,
}: TextConflictBlockProps): JSX.Element {
  const selectedSide = decision.mode === 'block' ? decision.side : undefined;
  const isRemoved = decision.mode === 'remove';

  const selectBlock = (side: ConflictSide): void => {
    onDecision({ mode: 'block', side });
    onExpandedChange(false);
  };

  const toggleExpanded = (): void => {
    if (!expanded) {
      onDecision(createLineDecision(region, decision));
    }
    onExpandedChange(!expanded);
  };

  const toggleLine = (side: ConflictSide, index: number): void => {
    const lineDecision = createLineDecision(region, decision);
    if (lineDecision.mode !== 'lines') {
      return;
    }

    onDecision({
      mode: 'lines',
      lines: {
        current: lineDecision.lines.current.map((selected, lineIndex) => (
          side === 'current' && lineIndex === index ? !selected : selected
        )),
        incoming: lineDecision.lines.incoming.map((selected, lineIndex) => (
          side === 'incoming' && lineIndex === index ? !selected : selected
        )),
      },
    });
  };

  return (
    <section className="rounded-lg border border-theme-default bg-theme-base/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-theme-primary">Choose the result for this section</h4>
          <p className="mt-1 text-xs text-theme-muted">Use one complete version or choose individual lines.</p>
        </div>
        {(selectedSide || isRemoved) && (
          <span className="inline-flex items-center gap-1 text-xs text-green-400">
            <Check className="h-3.5 w-3.5" />
            {isRemoved ? 'Section removed' : selectedSide === 'current' ? 'Current selected' : 'Incoming selected'}
          </span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {(['current', 'incoming'] as const).map((side) => {
          const lines = region[side];
          const isSelected = selectedSide === side;

          return (
            <button
              key={side}
              type="button"
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => selectBlock(side)}
              className={`min-w-0 rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                isSelected
                  ? side === 'current'
                    ? 'border-blue-400 bg-blue-500/10'
                    : 'border-amber-400 bg-amber-500/10'
                  : side === 'current'
                    ? 'border-blue-500/30 hover:bg-blue-500/5'
                    : 'border-amber-500/30 hover:bg-amber-500/5'
              }`}
            >
              <span className="text-sm font-medium text-theme-primary">
                {side === 'current' ? 'Use Current' : 'Use Incoming'}
              </span>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-theme-secondary">
                {lines.join(newline) || '(No content)'}
              </pre>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? 'Hide line choices' : 'Choose individual lines'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onRequestRemove}
          className="text-red-400 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove this section
        </Button>
      </div>

      {expanded && decision.mode === 'lines' && (
        <div className="mt-3 grid gap-3 border-t border-theme-default pt-3 md:grid-cols-2">
          {(['current', 'incoming'] as const).map((side) => (
            <fieldset key={side} className="min-w-0">
              <legend className="mb-2 text-xs font-medium text-theme-primary">
                {side === 'current' ? 'Current lines' : 'Incoming lines'}
              </legend>
              <div className="space-y-1 rounded-md border border-theme-default bg-theme-base p-2">
                {region[side].length === 0 ? (
                  <p className="px-2 py-1 text-xs text-theme-muted">No lines in this version.</p>
                ) : region[side].map((line, index) => (
                  <label
                    key={`${side}-${index}`}
                    className="flex min-w-0 cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-theme-muted/10"
                  >
                    <input
                      type="checkbox"
                      checked={decision.lines[side][index]}
                      disabled={disabled}
                      onChange={() => toggleLine(side, index)}
                      aria-label={`${side === 'current' ? 'Current' : 'Incoming'} line ${index + 1}: ${line || 'blank line'}`}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <code className="min-w-0 whitespace-pre-wrap break-words text-xs text-theme-secondary">
                      {line || ' '}
                    </code>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </section>
  );
}

export default TextConflictBlock;
