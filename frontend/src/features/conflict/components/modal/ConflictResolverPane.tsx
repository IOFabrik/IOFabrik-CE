import { Loader2 } from 'lucide-react';

import type {
  ResolutionStrategy,
} from '../../../../domain/repo/context/RepoContext.types';
import { isFileKind } from '../../../../shared/constants/file-types';
import type {
  ConflictRegionDecision,
  ConflictResolutionData,
  TextConflictDraft,
} from '../../types';
import L5XConflictResolver from './L5XConflictResolver';
import TextConflictResolver from './TextConflictResolver';
import WholeFileConflictFallback from './WholeFileConflictFallback';

const INELIGIBLE_REASON_LABELS: Record<string, string> = {
  'unsafe-file-type': 'This file type needs a complete-file choice.',
  'missing-side': 'One version of this file is missing, so choose the complete result.',
  'file-too-large': 'This file is too large for section-by-section review.',
  'binary-content': 'This file is not plain text and needs a complete-file choice.',
  'unsupported-encoding': 'This file uses a text format that cannot be reviewed safely here.',
  'unsupported-content': 'This file contains content that cannot be reviewed safely here.',
  'line-ending-mismatch': 'The two versions use incompatible line endings.',
  'conflict-generation-failed': 'IOFabrik could not separate this file into safe review sections.',
  'output-too-large': 'The resolved file would be too large for section-by-section review.',
};

interface ConflictResolverPaneProps {
  file: { path: string };
  data?: ConflictResolutionData;
  draft?: TextConflictDraft;
  isLoading: boolean;
  loadError?: string;
  applyError?: string;
  disabled: boolean;
  onDecision: (regionId: string, decision: ConflictRegionDecision) => void;
  onApply: () => void | Promise<void>;
  onResolveWholeFile: (strategy: ResolutionStrategy) => void | Promise<void>;
}

function ConflictResolverPane({
  file,
  data,
  draft,
  isLoading,
  loadError,
  applyError,
  disabled,
  onDecision,
  onApply,
  onResolveWholeFile,
}: ConflictResolverPaneProps): JSX.Element {
  if (isLoading) {
    return (
      <div className="flex min-h-[28rem] items-center justify-center rounded-lg border border-theme-default bg-theme-surface">
        <span className="inline-flex items-center gap-2 text-sm text-theme-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading conflict details...
        </span>
      </div>
    );
  }

  if (data?.success && data.eligible && data.resolutionToken && draft) {
    if (isFileKind(file.path, 'l5x')) {
      return (
        <L5XConflictResolver
          data={data}
          draft={draft}
          disabled={disabled}
          applyError={applyError}
          onDecision={onDecision}
          onApply={onApply}
          onResolveWholeFile={onResolveWholeFile}
        />
      );
    }
    return (
      <TextConflictResolver
        data={data}
        draft={draft}
        disabled={disabled}
        applyError={applyError}
        onDecision={onDecision}
        onApply={onApply}
      />
    );
  }

  const reason = loadError
    || data?.error
    || (data?.ineligibleReason ? INELIGIBLE_REASON_LABELS[data.ineligibleReason] : undefined);

  return (
    <WholeFileConflictFallback
      path={file.path}
      disabled={disabled}
      reason={reason}
      onResolve={onResolveWholeFile}
    />
  );
}

export default ConflictResolverPane;