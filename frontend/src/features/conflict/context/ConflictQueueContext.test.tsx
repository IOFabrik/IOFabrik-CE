import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictQueueEntry, ConflictQueueSnapshot } from '../../../../bindings/iofabrik/services/models';
import { ConflictQueueProvider, useConflictQueue } from './ConflictQueueContext';

const { repoStore, bindings, eventBus, integrationStore } = vi.hoisted(() => ({
  repoStore: { current: { repoPath: '/repo', conflictedFiles: [] as unknown[] } },
  bindings: {
    SetRepository: vi.fn(),
    ClearRepository: vi.fn(),
    Refresh: vi.fn(),
  },
  eventBus: { handler: null as ((event: { data: unknown }) => void) | null },
  integrationStore: {
    current: {
      enabled: false,
      entries: [] as ConflictQueueEntry[],
      error: null as string | null,
      refresh: vi.fn(),
    },
  },
}));

vi.mock('../../../context', () => ({
  useRepo: () => repoStore.current,
}));

vi.mock('../../integration', () => ({
  useIntegrationSession: () => integrationStore.current,
}));

vi.mock('../../../../bindings/iofabrik/services/conflictqueueservice', () => bindings);

vi.mock('../../../shared/runtime/events', () => ({
  onEvent: (_name: string, handler: (event: { data: unknown }) => void) => {
    eventBus.handler = handler;
    return () => {
      eventBus.handler = null;
    };
  },
}));

function snapshot(
  generation: number,
  paths: string[],
  overrides: Partial<ConflictQueueSnapshot> = {},
): ConflictQueueSnapshot {
  return new ConflictQueueSnapshot({
    repoPath: '/repo',
    generation,
    entries: paths.map((path) => new ConflictQueueEntry({ path })),
    scannedAt: generation,
    ...overrides,
  });
}

let refreshQueue: (() => Promise<void>) | null = null;

function Probe(): JSX.Element {
  const { entries, error, refresh } = useConflictQueue();
  refreshQueue = refresh;
  return (
    <div>
      <span data-testid="paths">{entries.map((entry) => entry.path).join(',')}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  );
}

async function renderProvider(): Promise<void> {
  await act(async () => {
    render(
      <ConflictQueueProvider>
        <Probe />
      </ConflictQueueProvider>,
    );
  });
}

describe('ConflictQueueProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoStore.current = { repoPath: '/repo', conflictedFiles: [] };
    integrationStore.current = {
      enabled: false,
      entries: [],
      error: null,
      refresh: vi.fn(),
    };
    bindings.SetRepository.mockResolvedValue(snapshot(1, ['a.txt']));
    bindings.ClearRepository.mockResolvedValue(snapshot(1, [], { repoPath: '' }));
    bindings.Refresh.mockResolvedValue(snapshot(1, ['a.txt']));
  });

  it('binds the open repository and exposes its entries', async () => {
    await renderProvider();
    expect(bindings.SetRepository).toHaveBeenCalledWith('/repo');
    expect(screen.getByTestId('paths')).toHaveTextContent('a.txt');
  });

  it('applies newer snapshots from events and ignores stale ones', async () => {
    await renderProvider();

    await act(async () => {
      eventBus.handler?.({ data: snapshot(2, ['b.txt']) });
    });
    expect(screen.getByTestId('paths')).toHaveTextContent('b.txt');

    await act(async () => {
      eventBus.handler?.({ data: snapshot(1, ['stale.txt']) });
    });
    expect(screen.getByTestId('paths')).toHaveTextContent('b.txt');
  });

  it('ignores snapshots belonging to another repository', async () => {
    await renderProvider();
    await act(async () => {
      eventBus.handler?.({ data: snapshot(3, ['other.txt'], { repoPath: '/elsewhere' }) });
    });
    expect(screen.getByTestId('paths')).toHaveTextContent('');
  });

  it('surfaces scan errors alongside the last good entries', async () => {
    await renderProvider();
    await act(async () => {
      eventBus.handler?.({ data: snapshot(4, ['a.txt'], { error: 'scan failed' }) });
    });
    expect(screen.getByTestId('error')).toHaveTextContent('scan failed');
    expect(screen.getByTestId('paths')).toHaveTextContent('a.txt');
  });

  it('clears the queue when no repository is open', async () => {
    repoStore.current = { repoPath: '', conflictedFiles: [] };
    await renderProvider();
    expect(bindings.ClearRepository).toHaveBeenCalled();
    expect(screen.getByTestId('paths')).toHaveTextContent('');
  });

  describe('with the isolated review as the source', () => {
    beforeEach(() => {
      integrationStore.current = {
        enabled: true,
        entries: [new ConflictQueueEntry({ path: 'session.txt' })],
        error: 'review scan failed',
        refresh: vi.fn(),
      };
    });

    it('reads entries from the review and unbinds the repository queue', async () => {
      await renderProvider();

      expect(bindings.SetRepository).not.toHaveBeenCalled();
      expect(bindings.ClearRepository).toHaveBeenCalled();
      expect(screen.getByTestId('paths')).toHaveTextContent('session.txt');
      expect(screen.getByTestId('error')).toHaveTextContent('review scan failed');
    });

    it('ignores repository queue events', async () => {
      await renderProvider();
      await act(async () => {
        eventBus.handler?.({ data: snapshot(9, ['repo.txt']) });
      });
      expect(screen.getByTestId('paths')).toHaveTextContent('session.txt');
    });

    it('refreshes the review instead of the repository queue', async () => {
      await renderProvider();
      await act(async () => {
        await refreshQueue?.();
      });

      expect(integrationStore.current.refresh).toHaveBeenCalled();
      expect(bindings.Refresh).not.toHaveBeenCalled();
    });
  });
});
