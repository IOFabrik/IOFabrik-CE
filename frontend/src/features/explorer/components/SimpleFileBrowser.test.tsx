import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Call } from '@wailsio/runtime';
import { FileEntry } from '../../../../bindings/iofabrik/services/models';

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  openFile: vi.fn(),
  revealInFinder: vi.fn(),
  copyToClipboard: vi.fn(),
  moveToTrash: vi.fn(),
  getRemoteURL: vi.fn(),
  getGitUser: vi.fn(),
  lfsLsFiles: vi.fn(),
  lfsLock: vi.fn(),
  lfsLocks: vi.fn(),
  lfsUnlock: vi.fn(),
  openExplorerTab: vi.fn(),
  syncRepo: vi.fn(),
  openExternalUrl: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  backendCall: vi.fn(),
  repoStatus: { changedFiles: [] as Array<{ path: string; status: string }> },
}));

vi.mock('../../../../bindings/iofabrik/services/filesystemservice', () => ({
  ListDirectoryWithOptions: mocks.listDirectory,
  OpenFile: mocks.openFile,
  RevealInFinder: mocks.revealInFinder,
  CopyToClipboard: mocks.copyToClipboard,
  MoveToTrash: mocks.moveToTrash,
}));

vi.mock('../../../../bindings/iofabrik/services/gitservice', () => ({
  GetRemoteURL: mocks.getRemoteURL,
}));

vi.mock('../../../../bindings/iofabrik/services/lfsservice', () => ({
  GetGitUser: mocks.getGitUser,
  LFSLsFiles: mocks.lfsLsFiles,
  LFSLock: mocks.lfsLock,
  LFSLocks: mocks.lfsLocks,
  LFSUnlock: mocks.lfsUnlock,
}));

vi.mock('@wailsio/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@wailsio/runtime')>(),
  Call: { ByID: mocks.backendCall },
}));

vi.mock('../../../context', () => ({
  useRepo: () => ({ repoStatus: mocks.repoStatus, syncRepo: mocks.syncRepo, isSyncing: false, refreshProjectDefaultBranch: vi.fn() }),
  useLayout: () => ({ openExplorerTab: mocks.openExplorerTab }),
}));

vi.mock('../../../shared/runtime/events', () => ({ onEvent: () => () => {} }));
vi.mock('../../../shared/runtime/browser', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('../../../viewers/registry/viewer-registry', () => ({
  getViewerForFile: (name: string) => ({ id: name.endsWith('.txt') ? 'text' : 'unsupported' }),
}));

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return {
    ...actual,
    // jsdom has no layout. Give the real virtualizer a fixed viewport for interactions.
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => actual.useVirtualizer({
      ...options,
      observeElementRect: (_instance, callback) => {
        callback({ width: 1200, height: 800 });
        return () => {};
      },
    }),
  };
});

import SimpleFileBrowser from './SimpleFileBrowser';

type Layout = 'grid' | 'list';

function fileEntry(name: string, directory = '/projects/Line.1', isDirectory = false) {
  return new FileEntry({ name, path: `${directory}/${name}`, isDirectory, isHidden: name.startsWith('.') });
}

async function renderBrowser(layout: Layout, entries: FileEntry[], directory = '/projects/Line.1') {
  mocks.listDirectory.mockImplementation(async (_path: string, showHidden: boolean) => ({
    entries: entries.filter((entry) => showHidden || !entry.isHidden),
  }));
  const result = render(<SimpleFileBrowser repoPath={directory} />);
  await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalled());
  if (entries.some((entry) => entry.isHidden)) {
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }));
  }
  await screen.findByRole('table', { name: 'Files' });
  if (layout === 'grid') fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
  return result;
}

async function openFileMenu(layout: Layout, name: string) {
  const accessibleName = name.replace(/\s+/g, ' ').trim();
  const label = await screen.findByText(accessibleName);
  const trigger = label.closest(layout === 'grid' ? 'button' : '[role="row"]');
  expect(trigger).not.toBeNull();
  if (!trigger) throw new Error(`Missing ${layout} entry for ${name}`);
  fireEvent.contextMenu(trigger);
  return screen.findByRole('menuitem', { name: 'Generate preview' });
}

async function closeFileMenu() {
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
}

describe.each<Layout>(['grid', 'list'])('Generate preview in the %s layout', { timeout: 15_000 }, (layout) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    mocks.repoStatus.changedFiles = [];
    mocks.getGitUser.mockResolvedValue('Engineer');
    mocks.lfsLsFiles.mockResolvedValue([]);
    mocks.lfsLocks.mockResolvedValue([]);
    mocks.openFile.mockResolvedValue({ success: true });
    mocks.copyToClipboard.mockResolvedValue({ success: true });
    mocks.backendCall.mockRejectedValue(new Error('Unexpected backend call'));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ['Controller.ACD', true],
    ['Controller.acd', true],
    ['Controller.AcD', true],
    ['Controller.BAK042.ACD', false],
    ['Controller.something.acd', false],
    ['Controller.acd.something', false],
    ['Controller.txt', false],
    ['Controller', false],
    ['.ACD', false],
    ['Controller..ACD', false],
    ['Controller.ACD\n', false],
  ])('checks %s when its menu opens (eligible: %s)', async (name, eligible) => {
    await renderBrowser(layout, [fileEntry(name)]);
    const item = await openFileMenu(layout, name);
    if (eligible) {
      expect(item).not.toHaveAttribute('aria-disabled', 'true');
    } else {
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAttribute('data-disabled');
      fireEvent.click(item);
      expect(mocks.toastInfo).not.toHaveBeenCalled();
    }
  });

  it.each(['/projects/Line.1', 'C:\\Projects\\Line.1'])('uses the basename under %s', async (directory) => {
    await renderBrowser(layout, [fileEntry('Controller.ACD', directory)], directory);
    expect(await openFileMenu(layout, 'Controller.ACD')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('updates eligibility when opening another file and reopening the first', async () => {
    await renderBrowser(layout, [fileEntry('Controller.ACD'), fileEntry('Controller.BAK042.ACD')]);
    expect(await openFileMenu(layout, 'Controller.ACD')).not.toHaveAttribute('aria-disabled', 'true');
    await closeFileMenu();
    expect(await openFileMenu(layout, 'Controller.BAK042.ACD')).toHaveAttribute('aria-disabled', 'true');
    await closeFileMenu();
    expect(await openFileMenu(layout, 'Controller.ACD')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps eligibility consistent after switching layouts', async () => {
    await renderBrowser(layout, [fileEntry('Controller.ACD'), fileEntry('Controller.BAK042.ACD')]);
    expect(await openFileMenu(layout, 'Controller.ACD')).not.toHaveAttribute('aria-disabled', 'true');
    await closeFileMenu();
    const nextLayout = layout === 'grid' ? 'list' : 'grid';
    fireEvent.click(screen.getByRole('button', { name: nextLayout === 'grid' ? 'Grid view' : 'List view' }));
    expect(await openFileMenu(nextLayout, 'Controller.BAK042.ACD')).toHaveAttribute('aria-disabled', 'true');
    await closeFileMenu();
    expect(await openFileMenu(nextLayout, 'Controller.ACD')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('allows eligible tracked, untracked, and ignored entries regardless of status or LFS tracking', async () => {
    mocks.repoStatus.changedFiles = [
      { path: 'Tracked.ACD', status: 'modified' },
      { path: 'Untracked.ACD', status: 'untracked' },
    ];
    // Ignored files are listed by the filesystem but absent from Git status.
    mocks.lfsLsFiles.mockResolvedValue(['Tracked.ACD']);
    await renderBrowser(layout, ['Tracked.ACD', 'Untracked.ACD', 'Ignored.ACD'].map((name) => fileEntry(name)));
    for (const name of ['Tracked.ACD', 'Untracked.ACD', 'Ignored.ACD']) {
      expect(await openFileMenu(layout, name)).not.toHaveAttribute('aria-disabled', 'true');
      await closeFileMenu();
    }
  });

  it('only shows placeholder feedback when selected, without backend calls or opening a viewer', async () => {
    await renderBrowser(layout, [fileEntry('Controller.ACD')]);
    await waitFor(() => {
      expect(mocks.getGitUser).toHaveBeenCalled();
      expect(mocks.lfsLsFiles).toHaveBeenCalled();
      expect(mocks.lfsLocks).toHaveBeenCalled();
    });
    vi.clearAllMocks();
    fireEvent.click(await openFileMenu(layout, 'Controller.ACD'));
    expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith('Preview generation is not available yet.');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    for (const method of [
      Call.ByID, mocks.listDirectory, mocks.getGitUser, mocks.lfsLsFiles, mocks.lfsLocks,
      mocks.lfsLock, mocks.lfsUnlock, mocks.getRemoteURL, mocks.openFile, mocks.moveToTrash,
      mocks.revealInFinder, mocks.copyToClipboard, mocks.openExplorerTab, mocks.syncRepo, mocks.openExternalUrl,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('does not offer generation for a directory named Controller.ACD', async () => {
    await renderBrowser(layout, [fileEntry('Controller.ACD', '/projects/Line.1', true)]);
    const trigger = layout === 'grid'
      ? await screen.findByRole('button', { name: 'Controller.ACD' })
      : await screen.findByRole('row', { name: /Controller\.ACD/ });
    fireEvent.contextMenu(trigger);
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Generate preview' })).not.toBeInTheDocument();
  });

  it('preserves Open, Preview, and Copy Name actions', async () => {
    const file = fileEntry('Notes.txt');
    await renderBrowser(layout, [file]);
    await openFileMenu(layout, file.name);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Open/ }));
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledWith(file.path));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await openFileMenu(layout, file.name);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Preview/ }));
    expect(mocks.openExplorerTab).toHaveBeenCalledWith(expect.objectContaining({ filePath: file.path, viewerId: 'text' }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await openFileMenu(layout, file.name);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Name' }));
    await waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(file.name));
  });
});
