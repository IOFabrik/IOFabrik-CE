import { memo, useCallback, useState } from "react";
import { AlertCircle, TriangleAlert } from "lucide-react";
import {
  FBDDiagram,
  StructuredTextViewer,
  RawRoutineViewer,
  VirtualizedLadderDiagram,
  type FBDDiagramDiagnostic,
  type InstructionContext,
  type NormalizedFBDBody,
  type NormalizedRoutine,
} from "ladder-visualizer";

import { ICON_SIZES } from "../../../../shared/constants";
import { IOFABRIK_LADDER_THEME } from "./theme";

interface L5XRoutineViewerProps {
  routine: NormalizedRoutine;
  instructionContext?: InstructionContext;
  fbdSheetIndex?: number;
  onFbdSheetIndexChange?: (sheetIndex: number) => void;
}

interface ReportedFBDDiagnostics {
  body: NormalizedFBDBody;
  diagnostics: readonly FBDDiagramDiagnostic[];
}

function UnsupportedRoutine({ routineType }: { routineType: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-theme-secondary">
      <p className="font-medium text-theme-primary">
        {routineType} Visualization Not Supported
      </p>
      <p className="text-sm">
        {routineType === "SFC"
          ? "Sequential Function Chart (SFC) visualization is not yet supported"
          : `${routineType} routine visualization is not yet supported`}
      </p>
    </div>
  );
}

function MissingFBDContent() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 text-theme-secondary"
      role="alert"
    >
      <AlertCircle size={ICON_SIZES.lg} className="text-red-400" />
      <div className="text-center">
        <p className="mb-1 font-medium text-theme-primary">
          Cannot render FBD routine
        </p>
        <p className="text-sm">
          Normalized Function Block Diagram content is unavailable.
        </p>
      </div>
    </div>
  );
}

function FBDRoutineViewer({
  body,
  sheetIndex,
  onSheetIndexChange,
}: {
  body: NormalizedFBDBody;
  sheetIndex?: number;
  onSheetIndexChange?: (sheetIndex: number) => void;
}) {
  const [reportedDiagnostics, setReportedDiagnostics] =
    useState<ReportedFBDDiagnostics>();
  const diagnostics =
    reportedDiagnostics?.body === body ? reportedDiagnostics.diagnostics : [];
  const handleDiagnostics = useCallback(
    (nextDiagnostics: readonly FBDDiagramDiagnostic[]) => {
      setReportedDiagnostics({ body, diagnostics: nextDiagnostics });
    },
    [body],
  );

  return (
    <div className="flex h-full min-h-48 w-full min-w-0 flex-col overflow-hidden">
      {diagnostics.length > 0 && (
        <div
          className="flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs"
          style={{
            backgroundColor: "var(--color-warning-bg)",
            borderColor: "var(--color-warning-border)",
            color: "var(--color-warning)",
          }}
          role="status"
          aria-live="polite"
        >
          <TriangleAlert
            size={ICON_SIZES.sm}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span>
            {diagnostics.length} FBD{" "}
            {diagnostics.length === 1 ? "diagnostic" : "diagnostics"}:{" "}
            {diagnostics.map((diagnostic) => diagnostic.message).join(" ")}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <FBDDiagram
          body={body}
          sheetIndex={sheetIndex}
          onSheetIndexChange={onSheetIndexChange}
          width="100%"
          height="100%"
          className="h-full w-full"
          theme={IOFABRIK_LADDER_THEME}
          showControls
          showBackground
          showMiniMap={false}
          interactive
          onDiagnostics={handleDiagnostics}
        />
      </div>
    </div>
  );
}

/** Shared routine renderer used by program-owned and AOI-owned tabs. */
export const L5XRoutineViewer = memo(function L5XRoutineViewer({
  routine,
  instructionContext,
  fbdSheetIndex,
  onFbdSheetIndexChange,
}: L5XRoutineViewerProps) {
  if (routine.type === "SFC") {
    return <RawRoutineViewer routine={routine} className="h-full w-full" />;
  }

  if (routine.type === "ST") {
    return <StructuredTextViewer routine={routine} className="h-full w-full" />;
  }

  if (routine.type === "RLL") {
    return (
      <VirtualizedLadderDiagram
        routine={routine}
        instructionContext={instructionContext}
        theme={IOFABRIK_LADDER_THEME}
        className="h-full"
      />
    );
  }

  if (routine.type === "FBD") {
    return routine.fbd ? (
      <FBDRoutineViewer
        body={routine.fbd}
        sheetIndex={fbdSheetIndex}
        onSheetIndexChange={onFbdSheetIndexChange}
      />
    ) : (
      <MissingFBDContent />
    );
  }

  return <UnsupportedRoutine routineType={routine.type} />;
});
