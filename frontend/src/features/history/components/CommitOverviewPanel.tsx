/**
 * CommitOverviewPanel - Shared commit detail UI used by Explorer commit tabs.
 */
import { memo, useCallback, useMemo, useState, type CSSProperties } from 'react';
import {
  FileText,
  User,
  Clock,
  Eye,
  Plus,
  Minus,
  Hash,
  GitBranch,
  ChevronLeft,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { ICON_SIZES } from '../../../shared/constants';
import type {
  BranchList,
  CommitDetail,
  FileDiff,
  GraphCommit,
  RepoInfo,
  RepoStatus,
} from '../../../context';
import LoadingState from '../../../shared/ui/LoadingState';
import { DiffRenderer } from '../../../viewers/components/shared/DiffRenderer';
import { buildCommitDiffRequest } from '../../../viewers/registry/diff-request-adapters';
import {
  Button,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui';

interface CommitFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  hasNoLineStats?: boolean;
}

interface ResolveCommitBranchNameParams {
  commit: CommitDetail;
  graphCommits: GraphCommit[];
  branches: BranchList | null;
  repoStatus: RepoStatus | null;
  repoInfo: RepoInfo | null;
}

interface CommitOverviewPanelProps {
  repoPath: string | null;
  commit: CommitDetail;
  graphCommits?: GraphCommit[];
  branches?: BranchList | null;
  repoStatus?: RepoStatus | null;
  repoInfo?: RepoInfo | null;
  selectedFilePath?: string | null;
  currentDiff?: FileDiff | null;
  isDiffLoading?: boolean;
  onSelectFile: (filePath: string) => void;
  onBackToCommit?: () => void;
  onRestoreCommit: (commitHash: string) => Promise<boolean>;
  operationInProgress?: boolean;
}

const iconStyle: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };
const iconXsStyle: CSSProperties = { width: ICON_SIZES.xs, height: ICON_SIZES.xs };

function getCommitFileKey(file: CommitFile): string {
  return file.oldPath && file.oldPath !== file.path
    ? `${file.oldPath}->${file.path}`
    : file.path;
}

function getCommitFileDisplayPath(file: CommitFile): string {
  return file.oldPath && file.oldPath !== file.path
    ? `${file.oldPath} → ${file.path}`
    : file.path;
}

function shouldShowLineStats(file: CommitFile): boolean {
  if (file.hasNoLineStats) {
    return false;
  }

  return file.additions > 0 || file.deletions > 0;
}

export function resolveCommitBranchName({
  commit,
  graphCommits,
  branches,
  repoStatus,
  repoInfo,
}: ResolveCommitBranchNameParams): string | undefined {
  const currentBranchName = repoStatus?.branch || branches?.current || repoInfo?.branch;
  const graphCommit = graphCommits.find((candidate) => candidate.hash === commit.hash);

  if (!graphCommit?.refs?.length) {
    return currentBranchName;
  }

  const refs = graphCommit.refs.filter((ref) => ref && !ref.endsWith('/HEAD'));
  if (refs.length === 0) {
    return currentBranchName;
  }

  const localBranchNames = new Set([
    ...(branches?.local?.map((branch) => branch.name) ?? []),
    branches?.current,
    repoStatus?.branch,
    repoInfo?.branch,
  ].filter(Boolean) as string[]);

  const remoteBranchNames = new Set(
    (branches?.remote?.map((branch) => branch.name) ?? []).filter(Boolean),
  );

  const localRef = refs.find((ref) => localBranchNames.has(ref));
  if (localRef) {
    return localRef;
  }

  const remoteRef = refs.find((ref) => remoteBranchNames.has(ref));
  if (remoteRef) {
    return remoteRef;
  }

  return refs[0] || currentBranchName;
}

interface CommitHeaderProps {
  commit: CommitDetail;
  branchName?: string;
  onBack?: () => void;
  onRestore?: () => void;
  isRestoring?: boolean;
  operationInProgress?: boolean;
}

const CommitHeader = memo(function CommitHeader({
  commit,
  branchName,
  onBack,
  onRestore,
  isRestoring,
  operationInProgress,
}: CommitHeaderProps): JSX.Element {
  const parentCount = commit.parentHashes?.length ?? 0;
  const hasMergeLikeMessage = useMemo(() => {
    const subject = (commit.message || '').trim();
    const body = (commit.body || '').trim();
    return /^merge\b/i.test(subject)
      || /^squash merge\b/i.test(subject)
      || /squashed commit of the following:/i.test(body);
  }, [commit.message, commit.body]);
  const isMergeCommit = parentCount > 1 || hasMergeLikeMessage;
  const actionLabel = isMergeCommit ? 'merged changes' : 'saved changes';
  const absoluteTimestamp = useMemo(() => {
    const parsed = new Date(commit.date);
    if (Number.isNaN(parsed.getTime())) return commit.date;
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(parsed);
  }, [commit.date]);
  const friendlyDateTime = useMemo(() => {
    const parsed = new Date(commit.date);
    if (Number.isNaN(parsed.getTime())) return commit.relativeDate;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    const timePart = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(parsed);

    if (parsed >= startOfToday) {
      return `today at ${timePart}`;
    }
    if (parsed >= startOfYesterday && parsed < startOfToday) {
      return `yesterday at ${timePart}`;
    }

    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(parsed);
  }, [commit.date, commit.relativeDate]);

  return (
    <div className="border-b border-theme-default bg-fb-base">
      {onBack && (
        <div className="px-4 py-2 border-b border-theme-muted/50">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ChevronLeft style={iconStyle} />
            <span>Back to commit</span>
          </Button>
        </div>
      )}
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-theme-primary font-medium mb-1">
              {commit.author} {actionLabel} {friendlyDateTime}
            </h2>
            <p className="text-theme-secondary text-sm mb-2 break-words">&quot;{commit.message}&quot;</p>
            {commit.body && (
              <p className="text-theme-secondary text-sm mb-3 whitespace-pre-wrap">{commit.body}</p>
            )}
          </div>
          {onRestore && (
            <Button
              variant="default"
              size="sm"
              onClick={onRestore}
              disabled={isRestoring || operationInProgress}
              className="shrink-0 bg-theme-muted hover:bg-theme-elevated text-theme-primary border border-theme-default"
            >
              <RotateCcw style={iconStyle} className={isRestoring ? 'animate-spin' : ''} />
              <span>{isRestoring ? 'Restoring...' : 'Restore'}</span>
            </Button>
          )}
        </div>
        <div className="flex items-center flex-wrap gap-2 text-xs text-theme-muted">
          <span className={`px-2 py-0.5 rounded-full border ${isMergeCommit ? 'border-blue-500/50 text-blue-400 bg-blue-500/10' : 'border-theme-default text-theme-secondary bg-theme-muted/30'}`}>
            {isMergeCommit ? 'Merged changes' : 'Saved snapshot'}
          </span>
          <span className="px-2 py-0.5 rounded-full border border-theme-default text-theme-secondary bg-theme-muted/20">
            Parents: {parentCount}
          </span>
          {branchName && (
            <div className="flex items-center gap-1.5">
              <GitBranch style={iconXsStyle} />
              <span>{branchName}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Hash style={iconXsStyle} />
            <span>{commit.shortHash}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <User style={iconXsStyle} />
            <span>{commit.author}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock style={iconXsStyle} />
            <span>{commit.relativeDate} • {absoluteTimestamp}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3 text-xs">
          <span className="text-theme-secondary">
            {commit.stats?.filesChanged || 0} file{commit.stats?.filesChanged !== 1 ? 's' : ''} changed
          </span>
          <span className="text-green-400 flex items-center gap-1">
            <Plus style={iconXsStyle} />
            {commit.stats?.additions || 0}
          </span>
          <span className="text-red-400 flex items-center gap-1">
            <Minus style={iconXsStyle} />
            {commit.stats?.deletions || 0}
          </span>
        </div>
      </div>
    </div>
  );
});

interface CommitFileListProps {
  files: CommitFile[];
  onFileSelect: (filePath: string) => void;
  operationInProgress?: boolean;
}

const CommitFileList = memo(function CommitFileList({ files, onFileSelect, operationInProgress }: CommitFileListProps): JSX.Element {
  const statusColors: Record<string, string> = {
    added: 'text-green-400',
    modified: 'text-yellow-400',
    deleted: 'text-red-400',
    renamed: 'text-blue-400',
  };
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set());

  const allSelected = files.length > 0 && files.every((file) => selectedFiles.has(getCommitFileKey(file)));

  const toggleAllFiles = useCallback(() => {
    setSelectedFiles((current) => {
      if (files.length === 0) {
        return current;
      }

      if (files.every((file) => current.has(getCommitFileKey(file)))) {
        return new Set();
      }

      return new Set(files.map(getCommitFileKey));
    });
  }, [files]);

  const toggleFileSelection = useCallback((file: CommitFile) => {
    const key = getCommitFileKey(file);

    setSelectedFiles((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleRowRestore = useCallback((file: CommitFile) => {
    toast.info(`Restore for "${file.path}" is coming soon`);
  }, []);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-4 py-2 text-xs text-theme-muted uppercase tracking-wide border-b border-theme-muted/50 bg-fb-base shrink-0">
        Changed Files
      </div>
      <div className="flex-1 min-h-0 overflow-auto bg-fb-base">
        <Table>
          <TableHeader className="bg-fb-base">
            <TableRow className="hover:bg-fb-base">
              <TableHead className="h-8 w-12 py-1.5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAllFiles}
                  aria-label="Select all changed files"
                  className="h-4 w-4 rounded border-theme-default bg-theme-base"
                />
              </TableHead>
              <TableHead className="h-8 w-28 py-1.5">Status</TableHead>
              <TableHead className="h-8 py-1.5">File</TableHead>
              <TableHead className="h-8 w-32 py-1.5">Changed</TableHead>
              <TableHead className="h-8 w-24 py-1.5 text-right">Preview</TableHead>
              <TableHead className="h-8 w-24 py-1.5 text-right">Restore</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((file) => {
              const fileKey = getCommitFileKey(file);
              const isSelected = selectedFiles.has(fileKey);
              const showLineStats = shouldShowLineStats(file);
              const displayPath = getCommitFileDisplayPath(file);

              return (
                <TableRow key={fileKey} data-state={isSelected ? 'selected' : undefined}>
                  <TableCell className="py-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleFileSelection(file)}
                      aria-label={`Select ${file.path}`}
                      className="h-4 w-4 rounded border-theme-default bg-theme-base"
                    />
                  </TableCell>
                  <TableCell className="py-2">
                    <span className={`text-xs font-semibold uppercase ${statusColors[file.status] || 'text-theme-secondary'}`}>
                      {file.status}
                    </span>
                  </TableCell>
                  <TableCell className="py-2">
                    <div className="flex items-start gap-2">
                      <FileText style={iconStyle} className="text-theme-secondary shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-tight text-theme-primary break-all">{displayPath}</p>
                        {file.oldPath && file.oldPath !== file.path && (
                          <p className="text-xs leading-tight text-theme-muted break-all">Renamed from {file.oldPath}</p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="py-2">
                    {showLineStats ? (
                      <span className="text-xs text-theme-muted whitespace-nowrap">
                        <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{' '}
                        <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-theme-muted">Changed</span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 text-right">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onFileSelect(file.path)}>
                      <Eye style={iconXsStyle} />
                      <span>Preview</span>
                    </Button>
                  </TableCell>
                  <TableCell className="py-2 text-right">
                    <Button size="sm" variant="ghost" disabled={operationInProgress} className="h-6 px-2 text-[11px]" onClick={() => handleRowRestore(file)}>
                      <RotateCcw style={iconXsStyle} />
                      <span>Restore</span>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
});

function CommitOverviewPanel({
  repoPath,
  commit,
  graphCommits = [],
  branches = null,
  repoStatus = null,
  repoInfo = null,
  selectedFilePath = null,
  currentDiff = null,
  isDiffLoading = false,
  onSelectFile,
  onBackToCommit,
  onRestoreCommit,
  operationInProgress = false,
}: CommitOverviewPanelProps): JSX.Element {
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const branchName = useMemo(() => resolveCommitBranchName({
    commit,
    graphCommits,
    branches,
    repoStatus,
    repoInfo,
  }), [commit, graphCommits, branches, repoStatus, repoInfo]);

  const selectedFileInfo = useMemo(
    () => commit.files?.find((file) => file.path === selectedFilePath),
    [commit.files, selectedFilePath],
  );

  const handleRestoreClick = useCallback(() => {
    setShowRestoreConfirm(true);
  }, []);

  const handleRestoreConfirm = useCallback(async (): Promise<void> => {
    if (operationInProgress) return;
    setIsRestoring(true);
    try {
      await onRestoreCommit(commit.hash);
    } finally {
      setIsRestoring(false);
      setShowRestoreConfirm(false);
    }
  }, [commit.hash, onRestoreCommit, operationInProgress]);

  if (isDiffLoading) {
    return <LoadingState />;
  }

  const restoreConfirmModal = (
    <AlertDialog open={showRestoreConfirm} onOpenChange={setShowRestoreConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore this snapshot?</AlertDialogTitle>
          <AlertDialogDescription>
            This will create a new commit that undoes all changes from &quot;{commit.message}&quot;.
            {' '}Your commit history will be preserved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRestoring}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRestoreConfirm}
            disabled={isRestoring || operationInProgress}
          >
            {isRestoring ? 'Restoring...' : 'Restore'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (selectedFilePath && (currentDiff || repoPath)) {
    return (
      <div className="flex flex-col h-full min-h-0 bg-fb-base">
        <CommitHeader
          commit={commit}
          branchName={branchName}
          onBack={onBackToCommit}
          onRestore={handleRestoreClick}
          isRestoring={isRestoring}
        operationInProgress={operationInProgress}
        />
        <div className="flex-1 overflow-hidden min-h-0">
          <DiffRenderer
            {...buildCommitDiffRequest({
              repoPath,
              filePath: selectedFilePath,
              commitHash: commit.hash,
              parentHash: commit.parentHashes?.[0] ?? null,
              oldPath: selectedFileInfo?.oldPath,
              fileStatus: selectedFileInfo?.status,
              fileDiff: currentDiff as any,
              binary: (currentDiff as any)?.binary,
              showHeader: true,
            })}
          />
        </div>
        {restoreConfirmModal}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-fb-base">
      <CommitHeader
        commit={commit}
        branchName={branchName}
        onRestore={handleRestoreClick}
        isRestoring={isRestoring}
        operationInProgress={operationInProgress}
      />
      <CommitFileList
        key={commit.hash}
        files={(commit.files || []) as CommitFile[]}
        onFileSelect={onSelectFile}
        operationInProgress={operationInProgress}
      />
      {restoreConfirmModal}
    </div>
  );
}

export default memo(CommitOverviewPanel);