import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ConflictEligibility,
  ConflictFileKind,
  ConflictKind,
  ConflictQueueEntry,
  ConflictState,
} from '../../../../../bindings/iofabrik/services/models';
import ConflictQueueSection from './ConflictQueueSection';

const { queueStore } = vi.hoisted(() => ({
  queueStore: {
    current: {
      entries: [] as ConflictQueueEntry[],
      targetBranch: null as string | null,
      error: null as string | null,
      isEmpty: true,
      refresh: async () => {},
    },
  },
}));

vi.mock('../../context/ConflictQueueContext', () => ({
  useConflictQueue: () => queueStore.current,
}));

function makeEntry(overrides: Partial<ConflictQueueEntry>): ConflictQueueEntry {
  return new ConflictQueueEntry({
    path: 'src/app/main.go',
    state: ConflictState.ConflictStateActive,
    kind: ConflictKind.ConflictKindBothModified,
    fileKind: ConflictFileKind.ConflictFileKindText,
    eligibility: ConflictEligibility.ConflictEligible,
    sizeBytes: 100,
    hasBase: true,
    hasOurs: true,
    hasTheirs: true,
    ...overrides,
  });
}

function setQueue(
  entries: ConflictQueueEntry[],
  error: string | null = null,
  targetBranch: string | null = null
): void {
  queueStore.current = {
    entries,
    targetBranch,
    error,
    isEmpty: entries.length === 0,
    refresh: async () => {},
  };
}

describe('ConflictQueueSection', () => {
  it('renders nothing when there are no conflicts', () => {
    setQueue([]);
    const { container } = render(<ConflictQueueSection onSelectFile={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists filenames with a count and reports the file on click', () => {
    const entry = makeEntry({ path: 'src/app/main.go' });
    setQueue([entry, makeEntry({ path: 'docs/readme.md' })]);
    const onSelectFile = vi.fn();

    render(<ConflictQueueSection onSelectFile={onSelectFile} />);

    expect(screen.getByRole('heading', { name: 'Conflicts (2)' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('main.go'));
    expect(onSelectFile).toHaveBeenCalledWith(entry);
  });

  it('keeps ineligible files clickable and explains them', () => {
    setQueue([
      makeEntry({
        path: 'assets/logo.png',
        fileKind: ConflictFileKind.ConflictFileKindImage,
        eligibility: ConflictEligibility.ConflictIneligible,
        ineligibleReason: 'image',
      }),
    ]);

    render(<ConflictQueueSection onSelectFile={vi.fn()} />);

    const row = screen.getByRole('button', { name: /logo\.png/ });
    expect(row).toBeEnabled();
    expect(row).toHaveAccessibleName(/Image files are compared side by side/);
  });

  it('warns that the list may be stale when a scan failed', () => {
    setQueue([makeEntry({})], 'scan failed');
    render(<ConflictQueueSection onSelectFile={vi.fn()} />);
    expect(screen.getByText(/may be out of date/i)).toBeInTheDocument();
    expect(screen.getByText('main.go')).toBeInTheDocument();
  });

  it('lists conflicts the next merge will produce, naming the target branch', () => {
    setQueue(
      [makeEntry({ path: 'Cooker_1.L5X', state: ConflictState.ConflictStatePredicted })],
      null,
      'main'
    );

    render(<ConflictQueueSection onSelectFile={vi.fn()} />);

    expect(
      screen.getByText(
        'Based on your last sync, these files will likely need a decision when you merge into main.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cooker_1\.L5X/ })).toHaveAccessibleName(
      /when you merge into main/
    );
  });
});
