import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../context', () => ({
  useRepo: () => ({ progressModal: { isOpen: false }, handleProgressComplete: vi.fn() }),
  useLayout: () => ({ explorerMergeModalOpen: false, setExplorerMergeModalOpen: vi.fn() }),
}));
vi.mock('../../shared/ui', () => ({ Toaster: () => null, ProgressModal: () => null }));
vi.mock('../../shared/ui/RecoveryBanner', () => ({ default: () => null }));
vi.mock('./TopBar', () => ({ default: () => <header data-testid="unified-top-bar" /> }));
vi.mock('./ActivityBar', () => ({ default: () => null }));
vi.mock('./Sidebar', () => ({ default: () => <aside data-testid="sidebar" /> }));
vi.mock('./GitHubStatusBanner', () => ({ default: () => <footer data-testid="github-status-banner" /> }));
vi.mock('./MainArea', () => ({ default: () => <main data-testid="main-area" /> }));
vi.mock('./NonGitFolderPromptModal', () => ({ default: () => null }));
vi.mock('./AdditionalPackagesModal', () => ({ default: () => null }));
vi.mock('./GitIdentityPromptModal', () => ({ default: () => null }));
vi.mock('./DefaultBranchSyncConfirmModal', () => ({ default: () => null }));

import AppLayout from './AppLayout';

describe('Windows app shell', () => {
  it('keeps the sidebar and main area in one workspace beneath the top bar', () => {
    render(<AppLayout />);
    const bar = screen.getByTestId('unified-top-bar');
    expect(screen.queryByTestId('separate-title-bar')).not.toBeInTheDocument();
    const workspace = screen.getByTestId('workspace-container');
    expect(screen.getByTestId('sidebar').parentElement).toBe(workspace);
    expect(screen.getByTestId('main-area').parentElement?.parentElement).toBe(workspace);
    expect(
      bar.compareDocumentPosition(screen.getByTestId('sidebar')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
  it('keeps the GitHub status banner at the bottom, outside the scrolling workspace', () => {
    render(<AppLayout />);
    const workspace = screen.getByTestId('workspace-container');
    const banner = screen.getByTestId('github-status-banner');
    expect(banner.parentElement).toBe(workspace.parentElement?.parentElement);
    expect(banner.parentElement?.lastElementChild).toBe(banner);
  });

});
