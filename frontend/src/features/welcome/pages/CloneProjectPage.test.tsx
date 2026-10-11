import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CloneProjectPage from './CloneProjectPage';

const mockUseRepo = vi.fn();
const mockRepoList = vi.fn();
const mockRepoListForOrg = vi.fn();

vi.mock('../../../context', () => ({
  useRepo: () => mockUseRepo(),
}));

vi.mock('../../auth/components/GitHubDeviceFlowModal', () => ({
  default: () => null,
}));

vi.mock('../../auth/hooks/useGitHubDeviceFlow', () => ({
  useGitHubDeviceFlow: () => ({
    deviceFlow: {
      isOpen: false,
      userCode: '',
      verificationUrl: '',
    },
    startDeviceFlow: vi.fn(),
    closeDeviceFlow: vi.fn(),
    handleDeviceFlowOpenChange: vi.fn(),
  }),
}));

vi.mock('../../../../bindings/iofabrik/services/filedialogservice', () => ({
  OpenFolderDialog: vi.fn(),
}));

vi.mock('../../../../bindings/iofabrik/services/githubservice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../bindings/iofabrik/services/githubservice')>();

  return {
    ...actual,
    RepoList: (...args: unknown[]) => mockRepoList(...args),
    RepoListForOrg: (...args: unknown[]) => mockRepoListForOrg(...args),
    RepoClone: vi.fn(),
  };
});

describe('CloneProjectPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseRepo.mockReturnValue({
      openRepo: vi.fn(),
      ghInstalled: true,
      isInstallingPackages: false,
      installRequiredPackages: vi.fn(),
      ghAuthStatus: {
        loggedIn: true,
        username: 'me',
      },
      isCheckingGhAuth: false,
      loadUserOrganizations: vi.fn().mockResolvedValue({
        success: true,
        username: 'me',
        organizations: [
          { login: 'acme', name: 'Acme Automation' },
        ],
      }),
      startGitHubLogin: vi.fn(),
    });

    mockRepoList.mockResolvedValue({
      success: true,
      repos: [
        {
          fullName: 'me/personal-repo',
          description: 'Personal repo',
          private: false,
          language: 'TypeScript',
          stargazersCount: 0,
          forksCount: 0,
          updatedAt: '2026-03-25T10:00:00Z',
        },
      ],
    });

    mockRepoListForOrg.mockResolvedValue({
      success: true,
      repos: [
        {
          fullName: 'acme/plc-templates',
          description: 'Org repo',
          private: true,
          language: 'Go',
          stargazersCount: 0,
          forksCount: 0,
          updatedAt: '2026-03-24T10:00:00Z',
        },
      ],
    });
  });

  it('loads personal and organization repositories after GitHub login', async () => {
    render(<CloneProjectPage />);

    await waitFor(() => {
      expect(mockRepoList).toHaveBeenCalledWith(100, '');
      expect(mockRepoListForOrg).toHaveBeenCalledWith('acme', 100);
    });

    expect(await screen.findByText('me/personal-repo')).toBeInTheDocument();
    expect(await screen.findByText('acme/plc-templates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });
});