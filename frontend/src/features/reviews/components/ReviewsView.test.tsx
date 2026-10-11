import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubChangeRequest, GitHubChangeRequestError, GitHubChangeRequestFile } from '../../../domain/repo/context/RepoContext.types';

const selectChangeRequestFile = vi.fn();
const openExternalUrl = vi.fn();

const repoState: {
  selectedChangeRequest: GitHubChangeRequest | null;
  changeRequestFiles: GitHubChangeRequestFile[];
  changeRequestTotalFiles: number;
  isLoadingChangeRequestDetail: boolean;
  changeRequestDetailError: GitHubChangeRequestError | null;
  isChangeRequestFilesTruncated: boolean;
  selectedChangeRequestFilePath: string | null;
  selectChangeRequestFile: typeof selectChangeRequestFile;
} = {
  selectedChangeRequest: null,
  changeRequestFiles: [],
  changeRequestTotalFiles: 0,
  isLoadingChangeRequestDetail: false,
  changeRequestDetailError: null,
  isChangeRequestFilesTruncated: false,
  selectedChangeRequestFilePath: null,
  selectChangeRequestFile,
};

vi.mock('../../../context', () => ({
  useRepo: () => repoState,
}));

vi.mock('../../../shared/runtime/browser', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

import ReviewsView from './ReviewsView';

describe('ReviewsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoState.selectedChangeRequest = null;
    repoState.changeRequestFiles = [];
    repoState.changeRequestTotalFiles = 0;
    repoState.isChangeRequestFilesTruncated = false;
    repoState.changeRequestDetailError = null;
    repoState.selectedChangeRequestFilePath = null;
  });

  it('shows an overview helper until a Change Request is selected', () => {
    render(<ReviewsView />);

    expect(screen.getByText('Select a Change Request to see its changed files.')).toBeInTheDocument();
  });

  it('renders changed files in a folder tree and selects a file for the future viewer', () => {
    repoState.selectedChangeRequest = {
      number: 12,
      title: 'Adjust motor configuration',
      author: { login: 'current-user' },
    } as GitHubChangeRequest;
    repoState.changeRequestFiles = [
      { path: 'logic/Mixer.L5X', status: 'modified', additions: 12, deletions: 4 },
      { path: 'logic/safety/Interlock.L5X', status: 'added', additions: 8, deletions: 0 },
    ];

    render(<ReviewsView />);

    expect(screen.getByText('logic')).toBeInTheDocument();
    expect(screen.getByText('safety')).toBeInTheDocument();
    expect(screen.queryByText('Modified · +12 −4')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /logic\/Mixer\.L5X/i }));

    expect(selectChangeRequestFile).toHaveBeenCalledWith('logic/Mixer.L5X');
  });

  it('deselects the active file when it is clicked again', () => {
    repoState.selectedChangeRequest = {
      number: 12,
      title: 'Adjust motor configuration',
      author: { login: 'current-user' },
    } as GitHubChangeRequest;
    repoState.changeRequestFiles = [{ path: 'logic/Mixer.L5X', status: 'modified', additions: 12, deletions: 4 }];
    repoState.selectedChangeRequestFilePath = 'logic/Mixer.L5X';

    render(<ReviewsView />);

    fireEvent.click(screen.getByRole('button', { name: /logic\/Mixer\.L5X/i }));

    expect(selectChangeRequestFile).toHaveBeenCalledWith(null);
  });

  it('warns about a partial file list and links to GitHub', () => {
    repoState.selectedChangeRequest = {
      number: 12,
      title: 'Adjust motor configuration',
      url: 'https://github.com/iofabrik/plant-project/pull/12',
      author: { login: 'current-user' },
    } as GitHubChangeRequest;
    repoState.changeRequestFiles = [{ path: 'logic/Mixer.L5X', status: 'modified', additions: 12, deletions: 4 }];
    repoState.changeRequestTotalFiles = 400;
    repoState.isChangeRequestFilesTruncated = true;

    render(<ReviewsView />);

    expect(screen.getByTestId('change-request-truncation-banner')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 400')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open on GitHub' }));

    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/iofabrik/plant-project/pull/12');
  });

  it('explains a failed file load with recovery copy instead of raw backend text', () => {
    repoState.selectedChangeRequest = { number: 12, title: 'Adjust motor configuration' } as GitHubChangeRequest;
    repoState.changeRequestDetailError = { code: 'network_unavailable', message: 'dial tcp: lookup api.github.com' };

    render(<ReviewsView />);

    expect(screen.getByRole('alert')).toHaveTextContent('Check your connection and try again.');
  });
});