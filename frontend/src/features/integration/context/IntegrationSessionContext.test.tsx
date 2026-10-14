import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConflictQueueEntry,
  IntegrationSessionSnapshot,
  OperationResult,
  SessionConflictSnapshot,
} from '../../../../bindings/iofabrik/services/models';
import { IntegrationSessionProvider, useIntegrationSession } from './IntegrationSessionContext';

const { repoStore, repoRefresh, layoutStore, bindings, eventBus } = vi.hoisted(() => ({
  repoStore: { current: { repoPath: '/repo' } },
  repoRefresh: vi.fn(),
  layoutStore: { current: { developerModeEnabled: true } },
  bindings: {
    ListSessions: vi.fn(),
    UpdateFeatureFromDestination: vi.fn(),
    GetSessionConflicts: vi.fn(),
    GetSessionConflictResolutionData: vi.fn(),
    ShareSession: vi.fn(),
    CancelSession: vi.fn(),
    ResolveSessionConflictWithContent: vi.fn(),
    ResolveSessionConflictWithDecisions: vi.fn(),
    ResolveSessionConflictWithSide: vi.fn(),
  },
  eventBus: { handlers: new Map<string, (event: { data: unknown }) => void>() },
}));

vi.mock('../../../context', () => ({
  useRepo: () => ({ ...repoStore.current, refreshAll: repoRefresh }),
  useLayout: () => layoutStore.current,
}));

vi.mock('../../../../bindings/iofabrik/services/integrationsessionservice', () => bindings);

vi.mock('../../../shared/runtime/events', () => ({
  onEvent: (name: string, handler: (event: { data: unknown }) => void) => {
    eventBus.handlers.set(name, handler);
    return () => eventBus.handlers.delete(name);
  },
}));

function session(state: string, sessionId = 'abc'): IntegrationSessionSnapshot {
  return new IntegrationSessionSnapshot({ sessionId, state, targetBranch: 'main', active: true });
}

function conflicts(
  scannedAt: number,
  paths: string[],
  sessionId = 'abc',
): SessionConflictSnapshot {
  return new SessionConflictSnapshot({
    sessionId,
    scannedAt,
    entries: paths.map((path) => new ConflictQueueEntry({ path })),
  });
}

function Probe(): JSX.Element {
  const { session: current, entries, isSaveBlocked } = useIntegrationSession();
  return (
    <div>
      <span data-testid="state">{current?.state ?? ''}</span>
      <span data-testid="paths">{entries.map((entry) => entry.path).join(',')}</span>
      <span data-testid="save-blocked">{String(isSaveBlocked)}</span>
    </div>
  );
}

async function renderProvider(): Promise<void> {
  await act(async () => {
    render(
      <IntegrationSessionProvider>
        <Probe />
      </IntegrationSessionProvider>,
    );
  });
}

describe('IntegrationSessionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventBus.handlers.clear();
    repoStore.current = { repoPath: '/repo' };
    layoutStore.current = { developerModeEnabled: true };
    bindings.ListSessions.mockResolvedValue([session('needs-decisions')]);
    bindings.UpdateFeatureFromDestination.mockResolvedValue(new OperationResult({ success: true }));
    bindings.GetSessionConflicts.mockResolvedValue(conflicts(10, ['a.txt']));
    bindings.GetSessionConflictResolutionData.mockResolvedValue({
      success: true,
      path: 'a.txt',
      eligible: true,
      base: { present: true },
      current: { present: true },
      incoming: { present: true },
      regions: [],
      hasFinalNewline: true,
    });
    bindings.ShareSession.mockResolvedValue(new OperationResult({ success: true }));
    bindings.CancelSession.mockResolvedValue(new OperationResult({ success: true }));
    bindings.ResolveSessionConflictWithContent.mockResolvedValue(new OperationResult({ success: true }));
    bindings.ResolveSessionConflictWithDecisions.mockResolvedValue(new OperationResult({ success: true }));
    bindings.ResolveSessionConflictWithSide.mockResolvedValue(new OperationResult({ success: true }));
  });

  it('keeps persisted conflict sessions available with developer mode off', async () => {
    layoutStore.current = { developerModeEnabled: false };

    function Actions(): JSX.Element {
      const { startUpdate } = useIntegrationSession();
      return <button type="button" onClick={() => void startUpdate()}>prepare</button>;
    }

    await act(async () => {
      render(
        <IntegrationSessionProvider>
          <Probe />
          <Actions />
        </IntegrationSessionProvider>,
      );
    });

    await act(async () => {
      screen.getByText('prepare').click();
    });

    expect(bindings.ListSessions).toHaveBeenCalledWith('/repo');
    expect(bindings.UpdateFeatureFromDestination).toHaveBeenCalledWith('/repo');
    expect(screen.getByTestId('state')).toHaveTextContent('needs-decisions');
    expect(screen.getByTestId('paths')).toHaveTextContent('a.txt');
  });

  it('adopts the live review and the files it is asking about', async () => {
    await renderProvider();

    expect(bindings.ListSessions).toHaveBeenCalledWith('/repo');
    expect(screen.getByTestId('state')).toHaveTextContent('needs-decisions');
    expect(screen.getByTestId('paths')).toHaveTextContent('a.txt');
  });

  it('starts an opted-in update and adopts the result', async () => {
    bindings.ListSessions
      .mockResolvedValueOnce([])
      .mockResolvedValue([session('updated')]);

    function Actions(): JSX.Element {
      const { startUpdate } = useIntegrationSession();
      return <button type="button" onClick={() => void startUpdate()}>prepare</button>;
    }

    await act(async () => {
      render(
        <IntegrationSessionProvider>
          <Probe />
          <Actions />
        </IntegrationSessionProvider>,
      );
    });

    await act(async () => {
      screen.getByText('prepare').click();
    });

    expect(bindings.UpdateFeatureFromDestination).toHaveBeenCalledWith('/repo');
    expect(screen.getByTestId('state')).toHaveTextContent('updated');
  });

  it('loads decision files returned by an on-demand check', async () => {
    bindings.ListSessions
      .mockResolvedValueOnce([])
      .mockResolvedValue([session('needs-decisions')]);

    function Actions(): JSX.Element {
      const { startUpdate } = useIntegrationSession();
      return <button type="button" onClick={() => void startUpdate()}>prepare</button>;
    }

    await act(async () => {
      render(
        <IntegrationSessionProvider>
          <Probe />
          <Actions />
        </IntegrationSessionProvider>,
      );
    });

    await act(async () => {
      screen.getByText('prepare').click();
    });

    expect(bindings.GetSessionConflicts).toHaveBeenCalledWith('abc');
    expect(screen.getByTestId('paths')).toHaveTextContent('a.txt');
  });

  it('ignores a review that is already over', async () => {
    bindings.ListSessions.mockResolvedValue([session('shared'), session('cancelled', 'def')]);
    await renderProvider();

    expect(screen.getByTestId('state')).toHaveTextContent('');
    expect(bindings.GetSessionConflicts).not.toHaveBeenCalled();
  });

  it('hides an updated session whose completed revision is no longer current', async () => {
    bindings.ListSessions.mockResolvedValue([
      new IntegrationSessionSnapshot({
        sessionId: 'abc',
        state: 'updated',
        active: false,
      }),
    ]);

    await renderProvider();

    expect(screen.getByTestId('state')).toHaveTextContent('');
  });

  it('keeps Save Changes blocked while a failed interrupted update needs recovery', async () => {
    bindings.ListSessions.mockResolvedValue([session('failed')]);

    await renderProvider();

    expect(screen.getByTestId('state')).toHaveTextContent('failed');
    expect(screen.getByTestId('save-blocked')).toHaveTextContent('true');
  });

  it('routes session state to the newly opened project', async () => {
    bindings.ListSessions.mockImplementation(async (repoPath: string) => (
      repoPath === '/other'
        ? [session('updated', 'def')]
        : [session('needs-decisions', 'abc')]
    ));

    let rendered: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(
        <IntegrationSessionProvider>
          <Probe />
        </IntegrationSessionProvider>,
      );
    });
    expect(screen.getByTestId('state')).toHaveTextContent('needs-decisions');

    repoStore.current = { repoPath: '/other' };
    await act(async () => {
      rendered.rerender(
        <IntegrationSessionProvider>
          <Probe />
        </IntegrationSessionProvider>,
      );
    });

    expect(bindings.ListSessions).toHaveBeenLastCalledWith('/other');
    expect(screen.getByTestId('state')).toHaveTextContent('updated');

    await act(async () => {
      eventBus.handlers.get('integrationSession:conflicts')?.({ data: conflicts(30, ['old.txt'], 'abc') });
    });
    expect(screen.getByTestId('paths')).toHaveTextContent('');
  });

  it('drops an old project response that finishes after project switching', async () => {
    let resolveOldProject: ((sessions: IntegrationSessionSnapshot[]) => void) | undefined;
    bindings.ListSessions.mockImplementation((repoPath: string) => {
      if (repoPath === '/repo') {
        return new Promise<IntegrationSessionSnapshot[]>((resolve) => {
          resolveOldProject = resolve;
        });
      }
      return Promise.resolve([session('updated', 'def')]);
    });

    let rendered: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(
        <IntegrationSessionProvider>
          <Probe />
        </IntegrationSessionProvider>,
      );
    });

    repoStore.current = { repoPath: '/other' };
    await act(async () => {
      rendered.rerender(
        <IntegrationSessionProvider>
          <Probe />
        </IntegrationSessionProvider>,
      );
    });
    expect(screen.getByTestId('state')).toHaveTextContent('updated');

    await act(async () => {
      resolveOldProject?.([session('needs-decisions', 'abc')]);
    });

    expect(screen.getByTestId('state')).toHaveTextContent('updated');
    expect(screen.getByTestId('paths')).toHaveTextContent('');
  });

  it('does not let an old project action clear or act on the new project session', async () => {
    let resolveOldShare: ((result: OperationResult) => void) | undefined;
    bindings.ListSessions.mockImplementation(async (repoPath: string) => (
      repoPath === '/other'
        ? [session('updated', 'def')]
        : [session('updated', 'abc')]
    ));
    bindings.ShareSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'abc') {
        return new Promise<OperationResult>((resolve) => {
          resolveOldShare = resolve;
        });
      }
      return Promise.resolve(new OperationResult({ success: true }));
    });

    function ShareAction(): JSX.Element {
      const { shareUpdate } = useIntegrationSession();
      return <button type="button" onClick={() => void shareUpdate()}>share current</button>;
    }

    let rendered: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(
        <IntegrationSessionProvider>
          <Probe />
          <ShareAction />
        </IntegrationSessionProvider>,
      );
    });
    fireEvent.click(screen.getByText('share current'));

    repoStore.current = { repoPath: '/other' };
    await act(async () => {
      rendered.rerender(
        <IntegrationSessionProvider>
          <Probe />
          <ShareAction />
        </IntegrationSessionProvider>,
      );
    });
    expect(screen.getByTestId('state')).toHaveTextContent('updated');

    await act(async () => {
      resolveOldShare?.(new OperationResult({ success: true }));
    });
    expect(screen.getByTestId('state')).toHaveTextContent('updated');

    fireEvent.click(screen.getByText('share current'));
    await act(async () => {});
    expect(bindings.ShareSession).toHaveBeenNthCalledWith(1, 'abc');
    expect(bindings.ShareSession).toHaveBeenNthCalledWith(2, 'def');
  });

  it('applies newer scans and drops stale ones and those for another review', async () => {
    await renderProvider();

    await act(async () => {
      eventBus.handlers.get('integrationSession:conflicts')?.({ data: conflicts(20, ['b.txt']) });
    });
    expect(screen.getByTestId('paths')).toHaveTextContent('b.txt');

    await act(async () => {
      eventBus.handlers.get('integrationSession:conflicts')?.({ data: conflicts(15, ['old.txt']) });
    });
    expect(screen.getByTestId('paths')).toHaveTextContent('b.txt');

    await act(async () => {
      eventBus.handlers.get('integrationSession:conflicts')?.({ data: conflicts(30, ['other.txt'], 'zzz') });
    });
    expect(screen.getByTestId('paths')).toHaveTextContent('b.txt');
  });

  it('re-reads when a state change arrives for a review it does not know', async () => {
    await renderProvider();
    bindings.ListSessions.mockResolvedValue([session('updated', 'def')]);

    await act(async () => {
      eventBus.handlers.get('integrationSession:changed')?.({ data: session('updated', 'def') });
    });

    expect(screen.getByTestId('state')).toHaveTextContent('updated');
    expect(screen.getByTestId('paths')).toHaveTextContent('');
  });

  it('shares and cancels the update it is showing', async () => {
    function Actions(): JSX.Element {
      const { shareUpdate, cancelUpdate } = useIntegrationSession();
      return (
        <div>
          <button type="button" onClick={() => void shareUpdate()}>share</button>
          <button type="button" onClick={() => void cancelUpdate()}>cancel</button>
        </div>
      );
    }

    await act(async () => {
      render(
        <IntegrationSessionProvider>
          <Actions />
        </IntegrationSessionProvider>,
      );
    });

    await act(async () => {
      screen.getByText('share').click();
    });
    expect(bindings.ShareSession).toHaveBeenCalledWith('abc');
    expect(repoRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByText('cancel').click();
    });
    expect(bindings.CancelSession).toHaveBeenCalledWith('abc');
  });

  it('loads and resolves conflict files through the active session', async () => {
    function Actions(): JSX.Element {
      const {
        loadConflictResolutionData,
        resolveConflictWithDecisions,
        resolveConflictWithContent,
        resolveConflictWithSide,
      } = useIntegrationSession();
      return (
        <div>
          <button type="button" onClick={() => void loadConflictResolutionData('a.txt')}>load</button>
          <button
            type="button"
            onClick={() => void resolveConflictWithDecisions('a.txt', 'token', {
              region: { mode: 'block', side: 'current' },
            })}
          >
            decide
          </button>
          <button
            type="button"
            onClick={() => void resolveConflictWithContent('a.txt', 'token', 'resolved')}
          >
            compose
          </button>
          <button type="button" onClick={() => void resolveConflictWithSide('a.txt', 'mine')}>side</button>
        </div>
      );
    }

    await act(async () => {
      render(
        <IntegrationSessionProvider>
          <Actions />
        </IntegrationSessionProvider>,
      );
    });

    await act(async () => {
      screen.getByText('load').click();
      screen.getByText('decide').click();
      screen.getByText('compose').click();
      screen.getByText('side').click();
    });

    expect(bindings.GetSessionConflictResolutionData).toHaveBeenCalledWith('abc', 'a.txt');
    expect(bindings.ResolveSessionConflictWithDecisions).toHaveBeenCalledWith(
      'abc',
      'a.txt',
      'token',
      [{ regionId: 'region', mode: 'block', side: 'current' }],
    );
    expect(bindings.ResolveSessionConflictWithContent).toHaveBeenCalledWith(
      'abc',
      'a.txt',
      'token',
      'resolved',
    );
    expect(bindings.ResolveSessionConflictWithSide).toHaveBeenCalledWith('abc', 'a.txt', 'mine');
  });
});
