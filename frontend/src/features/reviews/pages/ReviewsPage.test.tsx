import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChangeRequestSnapshot,
  GitHubChangeRequest,
  GitHubChangeRequestError,
  GitHubChangeRequestFile,
} from '../../../domain/repo/context/RepoContext.types';

const { startDeviceFlow, loadChangeRequests, closeDeviceFlow, openExternalUrl, ensureFileContent } = vi.hoisted(() => ({
  startDeviceFlow: vi.fn(),
  loadChangeRequests: vi.fn(),
  closeDeviceFlow: vi.fn(),
  openExternalUrl: vi.fn(),
  ensureFileContent: vi.fn(),
}));

const repoState: {
  repoPath: string;
  changeRequestRepository: null;
  changeRequests: GitHubChangeRequest[];
  changeRequestViewerLogin: string;
  changeRequestsMayHaveMore: boolean;
  isLoadingChangeRequests: boolean;
  changeRequestError: GitHubChangeRequestError | null;
  loadChangeRequests: typeof loadChangeRequests;
  selectedChangeRequest: GitHubChangeRequest | null;
  changeRequestFiles: GitHubChangeRequestFile[];
  changeRequestTotalFiles: number;
  isChangeRequestFilesTruncated: boolean;
  selectedChangeRequestFilePath: string | null;
  isLoadingChangeRequestDetail: boolean;
  changeRequestDetailError: GitHubChangeRequestError | null;
  changeRequestSnapshot: ChangeRequestSnapshot | null;
  isPreparingChangeRequestSnapshot: boolean;
  changeRequestSnapshotError: GitHubChangeRequestError | null;
  selectChangeRequest: ReturnType<typeof vi.fn>;
  returnToChangeRequestOverview: ReturnType<typeof vi.fn>;
  installRequiredPackages: ReturnType<typeof vi.fn>;
  isInstallingPackages: boolean;
} = {
  repoPath: '/tmp/plant-project',
  changeRequestRepository: null,
  changeRequests: [],
  changeRequestViewerLogin: 'current-user',
  changeRequestsMayHaveMore: false,
  isLoadingChangeRequests: false,
  changeRequestError: { code: 'auth_required' as const },
  loadChangeRequests,
  selectedChangeRequest: null,
  changeRequestFiles: [],
  changeRequestTotalFiles: 0,
  isChangeRequestFilesTruncated: false,
  selectedChangeRequestFilePath: null,
  isLoadingChangeRequestDetail: false,
  changeRequestDetailError: null,
  changeRequestSnapshot: null,
  isPreparingChangeRequestSnapshot: false,
  changeRequestSnapshotError: null,
  selectChangeRequest: vi.fn(),
  returnToChangeRequestOverview: vi.fn(),
  installRequiredPackages: vi.fn(),
  isInstallingPackages: false,
};

vi.mock('../../../domain/repo/services/repo-commands', () => ({
  EnsureChangeRequestFileContent: (...args: unknown[]) => ensureFileContent(...args),
}));

vi.mock('../../../viewers/components/shared/DiffRenderer', () => ({
  DiffRenderer: (props: { oldSide?: { ref?: string }; newSide?: { ref?: string } }) => (
    <div data-testid="diff-renderer" data-old-ref={props.oldSide?.ref} data-new-ref={props.newSide?.ref} />
  ),
}));

vi.mock('../../../context', () => ({
  useRepo: () => repoState,
}));

vi.mock('../../../shared/runtime/browser', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

vi.mock('../../auth/hooks/useGitHubDeviceFlow', () => ({
  useGitHubDeviceFlow: () => ({
    deviceFlow: { isOpen: false, userCode: '', verificationUrl: '' },
    startDeviceFlow,
    closeDeviceFlow,
    handleDeviceFlowOpenChange: vi.fn(),
  }),
}));

vi.mock('../../auth/components/GitHubDeviceFlowModal', () => ({
  default: () => null,
}));

import ReviewsPage from './ReviewsPage';

describe('ReviewsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoState.changeRequestError = { code: 'auth_required' };
    repoState.selectedChangeRequest = null;
    repoState.selectedChangeRequestFilePath = null;
    repoState.changeRequests = [];
    repoState.changeRequestFiles = [];
    repoState.isLoadingChangeRequestDetail = false;
    repoState.changeRequestDetailError = null;
    repoState.changeRequestSnapshot = null;
    repoState.isPreparingChangeRequestSnapshot = false;
    repoState.changeRequestSnapshotError = null;
    ensureFileContent.mockResolvedValue({ comparable: true, errorCode: '' });
  });

  it('starts the shared GitHub device flow when authentication is required', () => {
    render(<ReviewsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    expect(startDeviceFlow).toHaveBeenCalledOnce();
  });

  it('filters the table locally and loads a selected Change Request', () => {
    repoState.changeRequestError = null;
    repoState.changeRequests = [{
      number: 42,
      title: 'Update mixer sequence',
      body: 'Adds the requested mixer interlock.',
      url: 'https://github.com/iofabrik/plant-project/pull/42',
      state: 'OPEN',
      isDraft: false,
      author: { login: 'operator' },
      headRefName: 'work/mixer-interlock',
      headRefOid: 'head-oid',
      baseRefName: 'main',
      baseRefOid: 'base-oid',
      reviewDecision: '',
      mergeStateStatus: 'CLEAN',
      isCrossRepository: false,
      createdAt: '2026-07-20T10:00:00Z',
      updatedAt: '2026-07-21T10:00:00Z',
      reviewers: [{ login: 'reviewer', name: 'Review Engineer' }],
    }];

    render(<ReviewsPage />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search Change Requests' }), { target: { value: 'mixer' } });
    fireEvent.click(screen.getByRole('button', { name: /Update mixer sequence/i }));

    expect(repoState.selectChangeRequest).toHaveBeenCalledWith(42);
  });

  it('keeps the viewer area empty until a changed file is selected', () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = {
      number: 42,
      title: 'Update mixer sequence',
      body: 'Adds the requested mixer interlock.',
      url: 'https://github.com/iofabrik/plant-project/pull/42',
      author: { login: 'operator' },
      headRefName: 'work/mixer-interlock',
      baseRefName: 'main',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      reviewers: [{ login: 'reviewer', name: 'Review Engineer' }],
    } as GitHubChangeRequest;
    repoState.changeRequestFiles = [
      { path: 'logic/Mixer.L5X', status: 'modified', additions: 12, deletions: 4 },
      { path: 'hmi/panel.json', status: 'modified', additions: 3, deletions: 1 },
      { path: 'docs/notes.txt', status: 'added', additions: 5, deletions: 0 },
    ];

    render(<ReviewsPage />);

    expect(screen.getByTestId('change-request-header')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Change Request details' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('change-request-file-summary').closest('#change-request-details-42')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Change Request details' }));

    expect(screen.getByRole('button', { name: 'Expand Change Request details' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('change-request-file-summary')).toBeVisible();
    expect(screen.getByText('Adds the requested mixer interlock.')).toBeVisible();
    expect(screen.getByText('operator')).toBeVisible();
    expect(screen.getByText('work/mixer-interlock to main')).toBeVisible();
    expect(screen.getByText('Review Engineer')).toBeVisible();
    expect(screen.getByText('Approved')).toBeVisible();
    expect(screen.getByTestId('change-request-viewer-empty')).toBeInTheDocument();
  });

  it('collapses details for a selected file and expands them again when it is cleared', () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = {
      number: 42,
      title: 'Update mixer sequence',
      author: { login: 'operator' },
    } as GitHubChangeRequest;

    const { rerender } = render(<ReviewsPage key="request-42-empty" />);
    expect(screen.getByRole('button', { name: 'Collapse Change Request details' })).toHaveAttribute('aria-expanded', 'true');

    repoState.selectedChangeRequestFilePath = 'logic/Mixer.L5X';
    rerender(<ReviewsPage key="request-42-file" />);

    expect(screen.getByRole('button', { name: 'Expand Change Request details' })).toHaveAttribute('aria-expanded', 'false');

    repoState.selectedChangeRequestFilePath = null;
    rerender(<ReviewsPage key="request-42-empty-again" />);

    expect(screen.getByRole('button', { name: 'Collapse Change Request details' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('summarises changed project files in plain language before any diff is opened', () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = { number: 42, mergeStateStatus: 'BLOCKED' } as GitHubChangeRequest;
    repoState.changeRequestFiles = [
      { path: 'logic/Mixer.L5X', status: 'modified', additions: 12, deletions: 4 },
      { path: 'logic/Filler.L5X', status: 'modified', additions: 2, deletions: 0 },
      { path: 'hmi/panel.json', status: 'modified', additions: 3, deletions: 1 },
    ];

    render(<ReviewsPage />);

    expect(screen.getByTestId('change-request-file-summary')).toHaveTextContent(
      '2 ladder logic files, 1 HMI or configuration file',
    );
    expect(screen.getByText('Blocked by GitHub project rules')).toBeInTheDocument();
    expect(screen.queryByText('BLOCKED')).not.toBeInTheDocument();
  });

  it('opens the request on GitHub from the detail header', () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = {
      number: 42,
      url: 'https://github.com/iofabrik/plant-project/pull/42',
    } as GitHubChangeRequest;

    render(<ReviewsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open on GitHub' }));

    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/iofabrik/plant-project/pull/42');
  });

  it('reports a failed Change Request open instead of silently staying on the list', () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = null;
    repoState.changeRequestDetailError = { code: 'permission_denied' };

    render(<ReviewsPage />);

    expect(screen.getByTestId('change-request-detail-error')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub did not grant access to this project');

    fireEvent.click(screen.getByRole('button', { name: 'Return to overview' }));

    expect(repoState.returnToChangeRequestOverview).toHaveBeenCalledOnce();
  });

  it('shows progress while a Change Request is opening', () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = null;
    repoState.isLoadingChangeRequestDetail = true;

    render(<ReviewsPage />);

    expect(screen.getByTestId('change-request-detail-loading')).toBeInTheDocument();
  });

  it('reports snapshot progress instead of a diff while the changed files download', () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = { number: 42 } as GitHubChangeRequest;
    repoState.selectedChangeRequestFilePath = 'logic/Mixer.L5X';
    repoState.changeRequestFiles = [{ path: 'logic/Mixer.L5X', status: 'modified', additions: 1, deletions: 0 }];
    repoState.isPreparingChangeRequestSnapshot = true;

    render(<ReviewsPage />);

    expect(screen.getByTestId('change-request-preview-preparing')).toBeInTheDocument();
    expect(screen.queryByTestId('diff-renderer')).not.toBeInTheDocument();
  });

  it('renders the diff against the private snapshot refs once the file is comparable', async () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = { number: 42 } as GitHubChangeRequest;
    repoState.selectedChangeRequestFilePath = 'logic/Mixer.L5X';
    repoState.changeRequestFiles = [{ path: 'logic/Mixer.L5X', status: 'modified', additions: 1, deletions: 0 }];
    repoState.changeRequestSnapshot = {
      number: 42,
      headRef: 'refs/iofabrik/change-requests/42/head',
      baseRef: 'refs/iofabrik/change-requests/42/base',
      headOid: 'head-oid',
      baseOid: 'base-oid',
      baseTipOid: 'tip-oid',
    } as ChangeRequestSnapshot;

    render(<ReviewsPage />);

    const renderer = await screen.findByTestId('diff-renderer');
    expect(renderer).toHaveAttribute('data-old-ref', 'refs/iofabrik/change-requests/42/base');
    expect(renderer).toHaveAttribute('data-new-ref', 'refs/iofabrik/change-requests/42/head');
    expect(ensureFileContent).toHaveBeenCalledWith(
      '/tmp/plant-project',
      'refs/iofabrik/change-requests/42/base',
      'logic/Mixer.L5X',
      'refs/iofabrik/change-requests/42/head',
      'logic/Mixer.L5X',
    );
  });

  it('explains an unopenable file instead of mounting a viewer', async () => {
    repoState.changeRequestError = null;
    repoState.selectedChangeRequest = { number: 42, url: 'https://github.com/x/y/pull/42' } as GitHubChangeRequest;
    repoState.selectedChangeRequestFilePath = 'models/plant.step';
    repoState.changeRequestFiles = [{ path: 'models/plant.step', status: 'modified', additions: 0, deletions: 0 }];
    repoState.changeRequestSnapshot = {
      number: 42,
      headRef: 'refs/iofabrik/change-requests/42/head',
      baseRef: 'refs/iofabrik/change-requests/42/base',
    } as ChangeRequestSnapshot;
    ensureFileContent.mockResolvedValue({ comparable: false, errorCode: 'content_too_large' });

    render(<ReviewsPage />);

    expect(await screen.findByTestId('change-request-preview-problem')).toHaveTextContent('This file is too large to preview');
    expect(screen.queryByTestId('diff-renderer')).not.toBeInTheDocument();
  });
});