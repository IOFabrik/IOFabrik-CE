import { memo, useCallback, useMemo, useState } from 'react';
import { FBDDiffDiagram, RawRoutineViewer, type NormalizedFBDBody, type NormalizedRoutine, type InstructionContext } from 'ladder-visualizer';
import CodeMirrorTextViewer from '../../text/CodeMirrorTextViewer';
import { L5XRoutineViewer } from '../../file/l5x/L5XRoutineViewer';
import { IOFABRIK_LADDER_THEME } from '../../file/l5x/theme';
import type { L5XDiffRoutineEntity } from './types';

const SourceVersion = memo(function SourceVersion({ label, routine, text, instructionContext }: {
  label: string; routine?: NormalizedRoutine; text?: string; instructionContext: InstructionContext;
}) {
  return <section aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-theme-default">
    <h3 className="shrink-0 border-b border-theme-default px-3 py-2 text-xs font-medium text-theme-primary">
      {label}{routine ? ` (${routine.type})` : ''}
    </h3>
    <div className="min-h-0 flex-1">
      {!routine ? <p className="p-4 text-sm text-theme-secondary">Routine absent in this version.</p>
        : routine.type === 'ST' ? <CodeMirrorTextViewer content={text ?? routine.stContent?.map(line => line.text).join('\n') ?? ''} />
          : routine.rawSource && routine.type === 'SFC' ? <RawRoutineViewer routine={routine} className="h-full" />
            : <L5XRoutineViewer routine={routine} instructionContext={instructionContext} />}
    </div>
  </section>;
});

interface ReportedDiagnostics {
  oldBody?: NormalizedFBDBody;
  newBody?: NormalizedFBDBody;
  messages: readonly string[];
}

const FBDRoutineComparison = memo(function FBDRoutineComparison({ entity }: { entity: L5XDiffRoutineEntity }) {
  const diff = entity.routineDiff.fbdDiff;
  // The pinned public component takes source bodies, not a precomputed diff prop.
  const oldBody = diff ? diff.oldBody : entity.oldRoutine?.fbd;
  const newBody = diff ? diff.newBody : entity.newRoutine?.fbd;
  const [reported, setReported] = useState<ReportedDiagnostics>();
  const onDiagnostics = useCallback((messages: readonly string[]) => setReported(current =>
    current && current.oldBody === oldBody && current.newBody === newBody && current.messages.join('\n') === messages.join('\n')
      ? current : { oldBody, newBody, messages }), [oldBody, newBody]);
  const categories = useMemo(() => [...new Set([
    ...(diff?.propertyChanges.map(change => change.category) ?? []),
    ...(diff?.sheets.flatMap(sheet => [...sheet.categories,
      ...[...sheet.elements, ...sheet.connections, ...sheet.attachments].flatMap(item => item.categories)]) ?? []),
  ])], [diff]);
  const messages = [...new Set([
    ...(diff?.diagnostics.map(diagnostic => diagnostic.message) ?? []),
    ...(reported && reported.oldBody === oldBody && reported.newBody === newBody ? reported.messages : []),
  ])];
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-theme-default px-3 py-2 text-xs text-theme-secondary" role="status">
      {categories.length > 0 && <p>{categories.map(category => `${category.charAt(0).toUpperCase() + category.slice(1)} changes`).join(', ')}</p>}
      {diff?.complete === false && <p className="text-theme-warning">Comparison incomplete. Unpaired items do not establish additions or removals. Use Raw to inspect their source.</p>}
      {messages.length > 0 && <details open={diff?.complete === false}>
        <summary className="cursor-pointer">{messages.length} comparison diagnostics</summary>
        <ul className="max-h-32 overflow-auto py-1">{messages.map(message => <li key={message}>{message}</li>)}</ul>
      </details>}
    </div>
    <div className="min-h-0 flex-1">
      {oldBody || newBody ? <FBDDiffDiagram oldBody={oldBody} newBody={newBody} width="100%" height="100%"
        theme={IOFABRIK_LADDER_THEME} className="h-full w-full" onDiagnostics={onDiagnostics} />
        : <p className="p-4 text-sm text-theme-secondary">FBD comparison content is unavailable. Use Raw to inspect this routine.</p>}
    </div>
  </div>;
});

export const RoutineContentDiff = memo(function RoutineContentDiff({ entity }: { entity: L5XDiffRoutineEntity }) {
  const typeChanged = entity.oldRoutine && entity.newRoutine && entity.oldRoutine.type !== entity.newRoutine.type;
  if (!typeChanged && entity.routineType === 'FBD') return <FBDRoutineComparison entity={entity} />;
  return <div className="flex h-full min-h-0 divide-x divide-theme-default">
    <SourceVersion label="Previous version" routine={entity.oldRoutine} instructionContext={entity.oldInstructionContext} text={entity.routineDiff.stDiff?.oldText} />
    <SourceVersion label="Current version" routine={entity.newRoutine} instructionContext={entity.newInstructionContext} text={entity.routineDiff.stDiff?.newText} />
  </div>;
});
