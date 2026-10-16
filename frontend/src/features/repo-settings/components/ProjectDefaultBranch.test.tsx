import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, useContext, useRef } from 'react';
import {
  ProjectDefaultBranchAvailability, ProjectDefaultBranchMode, ProjectDefaultBranchResult,
} from '../../../../bindings/iofabrik/services/models';
import { useProjectDefaultBranch } from '../../../domain/repo/hooks/useProjectDefaultBranch';
import ProjectDefaultBranchCard from './ProjectDefaultBranchCard';
import ProjectDefaultBranchModal from '../../../widgets/layout/ProjectDefaultBranchModal';

const bindings = vi.hoisted(() => ({
  GetProjectDefaultBranch: vi.fn(), RefreshProjectDefaultBranch: vi.fn(),
  SetProjectDefaultBranch: vi.fn(), UseGitHubDefault: vi.fn(),
}));
vi.mock('../../../../bindings/iofabrik/services/repositorysettingsservice', () => bindings);
let api: ReturnType<typeof useProjectDefaultBranch>;
const testContext = createContext<ReturnType<typeof useProjectDefaultBranch> | null>(null);
vi.mock('../../../context', () => ({ useRepo: () => useContext(testContext)! }));

function result(branch = 'release/2026', manual = false): ProjectDefaultBranchResult {
  return new ProjectDefaultBranchResult({
    effectiveBranch: branch,
    availability: branch ? ProjectDefaultBranchAvailability.ProjectDefaultReady : ProjectDefaultBranchAvailability.ProjectDefaultNeedsSelection,
    mode: manual ? ProjectDefaultBranchMode.ProjectDefaultManual : ProjectDefaultBranchMode.ProjectDefaultAutomatic,
    originRepository: 'factory/project', lookupStatus: 'cached',
    choices: ['Release/2026', 'main', 'release/2026', 'trunk'],
  });
}

function Harness({ path = '/project-a' }: { path?: string }) {
  const session = useRef<{ path: string | null }>({ path });
  if (session.current.path !== path) session.current = { path };
  api = useProjectDefaultBranch(path, session);
  return <testContext.Provider value={api}><ProjectDefaultBranchCard /><ProjectDefaultBranchModal /></testContext.Provider>;
}

async function load(discover = false) {
  await act(async () => { await api.refreshProjectDefaultBranch(discover); });
}

async function choose(branch = 'trunk') {
  fireEvent.click(screen.getByRole('button', { name: 'Choose default branch' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'release/2026' }));
  fireEvent.click(screen.getByRole('button', { name: branch }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('alertdialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  bindings.GetProjectDefaultBranch.mockResolvedValue(result());
  bindings.RefreshProjectDefaultBranch.mockResolvedValue(result());
  bindings.SetProjectDefaultBranch.mockResolvedValue({ success: true });
  bindings.UseGitHubDefault.mockResolvedValue({ success: true });
});

describe('Project default branch Settings and chooser', () => {
  it('shows the effective branch and mode and performs discovery only on explicit refresh', async () => {
    render(<Harness />);
    await load();
    expect(screen.getByText('release/2026', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Selection: Automatic')).toBeInTheDocument();
    expect(bindings.RefreshProjectDefaultBranch).not.toHaveBeenCalled();
    bindings.RefreshProjectDefaultBranch.mockResolvedValue(result('trunk', true));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh default branch' }));
    await screen.findByText('trunk', { selector: 'strong' });
    expect(screen.getByText('Selection: Manual')).toBeInTheDocument();
    expect(bindings.RefreshProjectDefaultBranch).toHaveBeenCalledWith('/project-a');
  });

  it('requires the second generic confirmation and retains exact-case branch names', async () => {
    render(<Harness />);
    await load();
    await choose('Release/2026');
    expect(screen.getByText('Changing the default branch is a dangerous action. Are you sure you want to continue?')).toBeInTheDocument();
    expect(bindings.SetProjectDefaultBranch).not.toHaveBeenCalled();
    bindings.GetProjectDefaultBranch.mockResolvedValue(result('Release/2026', true));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await screen.findByText('Release/2026', { selector: 'strong' });
    expect(bindings.SetProjectDefaultBranch).toHaveBeenCalledExactlyOnceWith('/project-a', 'Release/2026');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('cancels without changing the preference or resuming an action', async () => {
    render(<Harness />);
    await load();
    bindings.GetProjectDefaultBranch.mockResolvedValue(result(''));
    let requested!: Promise<string | null>;
    await act(async () => { requested = api.ensureProjectDefaultBranch(); });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await requested).toBeNull();
    expect(bindings.SetProjectDefaultBranch).not.toHaveBeenCalled();
  });

  it('keeps the previous setting and confirmation visible after write failure', async () => {
    render(<Harness />);
    await load();
    await choose();
    bindings.SetProjectDefaultBranch.mockResolvedValue({ success: false, error: 'Personal settings could not be saved. Try again.' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await screen.findAllByRole('alert');
    expect(screen.getByText('release/2026', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('restores automatic mode and preserves a manual setting when restoration fails', async () => {
    render(<Harness />);
    bindings.GetProjectDefaultBranch.mockResolvedValue(result('trunk', true));
    await load();
    bindings.UseGitHubDefault.mockResolvedValue({ success: false, error: 'GitHub’s default is unavailable. Try refreshing.' });
    fireEvent.click(screen.getByRole('button', { name: 'Use GitHub default' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Selection: Manual')).toBeInTheDocument();
    bindings.UseGitHubDefault.mockResolvedValue({ success: true });
    bindings.GetProjectDefaultBranch.mockResolvedValue(result());
    fireEvent.click(screen.getByRole('button', { name: 'Use GitHub default' }));
    await screen.findByText('Selection: Automatic');
    expect(bindings.UseGitHubDefault).toHaveBeenCalledWith('/project-a');
  });

  it('resolves the waiting action once after successful confirmed selection', async () => {
    render(<Harness />);
    bindings.GetProjectDefaultBranch.mockResolvedValue(result(''));
    let requested!: Promise<string | null>;
    const resumed = vi.fn();
    await act(async () => { requested = api.ensureProjectDefaultBranch(); void requested.then(resumed); });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Choose a branch' }));
    fireEvent.click(screen.getByRole('button', { name: 'trunk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    bindings.GetProjectDefaultBranch.mockResolvedValue(result('trunk', true));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => expect(resumed).toHaveBeenCalledExactlyOnceWith('trunk'));
    expect(await requested).toBe('trunk');
  });

  it('cancels an old project’s chooser and ignores an old project’s lookup response', async () => {
    const view = render(<Harness />);
    await load();
    let requested!: Promise<string | null>;
    await act(async () => { requested = api.chooseProjectDefaultBranch(); });
    await screen.findByRole('dialog');
    view.rerender(<Harness path="/project-b" />);
    expect(await requested).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bindings.SetProjectDefaultBranch).not.toHaveBeenCalled();
    let finish!: (value: ProjectDefaultBranchResult) => void;
    bindings.RefreshProjectDefaultBranch.mockReturnValue(new Promise(done => { finish = done; }));
    let oldLookup!: Promise<ProjectDefaultBranchResult | null>;
    act(() => { oldLookup = api.refreshProjectDefaultBranch(true); });
    view.rerender(<Harness path="/project-c" />);
    await act(async () => { finish(result('trunk')); await oldLookup; });
    expect(screen.queryByText('trunk', { selector: 'strong' })).not.toBeInTheDocument();
  });

  it('selects a default for a new project without replacing the open project’s displayed default', async () => {
    render(<Harness />);
    await load();
    bindings.GetProjectDefaultBranch.mockImplementation(async (path: string) => result(path === '/new-project' ? '' : 'release/2026'));
    let requested!: Promise<string | null>;
    await act(async () => { requested = api.ensureProjectDefaultBranch('/new-project'); });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Choose a branch' }));
    fireEvent.click(screen.getByRole('button', { name: 'trunk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(bindings.SetProjectDefaultBranch).not.toHaveBeenCalled();
    bindings.GetProjectDefaultBranch.mockImplementation(async (path: string) => result(path === '/new-project' ? 'trunk' : 'release/2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => expect(bindings.SetProjectDefaultBranch).toHaveBeenCalledWith('/new-project', 'trunk'));
    expect(await requested).toBe('trunk');
    expect(api.projectDefaultBranch?.effectiveBranch).toBe('release/2026');
  });
});
