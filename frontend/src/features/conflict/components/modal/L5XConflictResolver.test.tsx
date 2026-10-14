import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConflictRegion,
  ConflictRegionDecision,
  ConflictResolutionData,
  TextConflictDraft,
} from '../../types';
import L5XConflictResolver from './L5XConflictResolver';

const classifyRegionMock = vi.fn();
const validateComposedDocumentMock = vi.fn();

function region(partial: Partial<ConflictRegion> & { id: string }): ConflictRegion {
  return {
    current: [],
    base: [],
    incoming: [],
    contextBefore: '',
    contextAfter: '',
    ...partial,
  };
}

vi.mock('ladder-visualizer', () => ({
  l5xConflictVisualAdapter: {
    format: 'l5x',
    classifyRegion: (...args: unknown[]) => classifyRegionMock(...args),
    validateComposedDocument: (...args: unknown[]) => validateComposedDocumentMock(...args),
  },
  VirtualizedLadderDiagram: ({ rungs }: { rungs: Array<{ number: number; comment?: string }> }) => (
    <div data-testid="rung-preview">rung-{rungs[0]?.number}{rungs[0]?.comment ? `-${rungs[0].comment}` : ''}</div>
  ),
  DARK_THEME: {},
  measureRoutineDiffRowHeight: () => 120,
}));

vi.mock('../../../../viewers/components/file/l5x/theme', () => ({
  IOFABRIK_LADDER_THEME: {},
}));

vi.mock('../../../../context/LayoutContext', () => ({
  useLayout: () => ({ theme: 'light' }),
}));

function buildData(overrides?: Partial<ConflictResolutionData>): ConflictResolutionData {
  return {
    success: true,
    path: 'Programs/Main.L5X',
    status: 'both-modified',
    eligible: true,
    base: { present: true },
    current: { present: true },
    incoming: { present: true },
    regions: [
      region({
        id: 'region-1',
        current: ['<Rung Number="0"><Text>XIC(A)OTE(B);</Text></Rung>'],
        base: [],
        incoming: ['<Rung Number="0"><Text>XIC(C)OTE(D);</Text></Rung>'],
        contextBefore: '<Controller>\n',
        contextAfter: '</Controller>\n',
      }),
    ],
    resolutionToken: 'token-1',
    newline: '\n',
    hasFinalNewline: true,
    ...overrides,
  };
}

function Harness({
  onApply,
  onResolveWholeFile = vi.fn(),
  resolutionData,
}: {
  onApply: () => void;
  onResolveWholeFile?: (strategy: 'mine' | 'theirs' | 'both') => void;
  resolutionData: ConflictResolutionData;
}): JSX.Element {
  const [draft, setDraft] = useState<TextConflictDraft>({
    path: resolutionData.path,
    resolutionToken: resolutionData.resolutionToken || '',
    decisions: Object.fromEntries(
      resolutionData.regions.map((conflictRegion) => [
        conflictRegion.id,
        { mode: 'unresolved' } satisfies ConflictRegionDecision,
      ]),
    ),
  });

  return (
    <L5XConflictResolver
      data={resolutionData}
      draft={draft}
      disabled={false}
      onDecision={(regionId, decision) =>
        setDraft((current) => ({ ...current, decisions: { ...current.decisions, [regionId]: decision } }))
      }
      onApply={onApply}
      onResolveWholeFile={onResolveWholeFile}
    />
  );
}

describe('L5XConflictResolver', () => {
  beforeEach(() => {
    classifyRegionMock.mockReset();
    validateComposedDocumentMock.mockReset();
  });

  it('renders a rung preview for eligible regions and applies the selected side', () => {
    classifyRegionMock.mockReturnValue({
      kind: 'ladder',
      current: { number: 0, comment: 'C', raw: 'raw', elements: [], instructions: [] },
      incoming: { number: 0, comment: 'I', raw: 'raw', elements: [], instructions: [] },
    });
    validateComposedDocumentMock.mockReturnValue({ valid: true });

    const onApply = vi.fn();
    render(<Harness onApply={onApply} resolutionData={buildData()} />);

    expect(screen.getAllByTestId('rung-preview')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Choose individual lines/ })).toBeNull();

    const resolveButton = screen.getByRole('button', { name: 'Resolve File' });
    expect(resolveButton).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'Use Current' }));
    expect(resolveButton).toBeEnabled();

    fireEvent.click(resolveButton);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('shows only the file name and whole-file actions in the header', () => {
    classifyRegionMock.mockReturnValue({
      kind: 'ladder',
      current: { number: 0, raw: 'raw', elements: [], instructions: [] },
      incoming: { number: 0, raw: 'raw', elements: [], instructions: [] },
    });

    const resolutionData = buildData({
      regions: [
        region({
          id: 'region-1',
          current: ['<![CDATA[NOP();]]>'],
          incoming: ['<![CDATA[OTE(a);]]>'],
          contextBefore: '<Rung Number="0" Type="N">\n<Text>\n',
          contextAfter: '</Text>\n</Rung>\n',
        }),
      ],
    });

    render(<Harness onApply={vi.fn()} resolutionData={resolutionData} />);

    expect(screen.getByText('Programs/Main.L5X')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep Current File' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep Incoming File' })).toBeInTheDocument();

    expect(screen.queryByText(/Resolve ladder logic conflicts/)).toBeNull();
    expect(screen.queryByText(/decided/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use all Current' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use all Incoming' })).toBeNull();
    expect(screen.queryByLabelText('Context before conflict')).toBeNull();
    expect(screen.queryByLabelText('Context after conflict')).toBeNull();
  });

  it('classifies only the region on screen', () => {
    classifyRegionMock.mockReturnValue({
      kind: 'ladder',
      current: { number: 0, raw: 'raw', elements: [], instructions: [] },
      incoming: { number: 0, raw: 'raw', elements: [], instructions: [] },
    });

    const resolutionData = buildData({
      regions: [
        region({ id: 'region-1', current: ['<Rung Number="0"/>'], incoming: ['<Rung Number="1"/>'] }),
        region({ id: 'region-2', current: ['<Rung Number="2"/>'], incoming: ['<Rung Number="3"/>'] }),
        region({ id: 'region-3', current: ['<Rung Number="4"/>'], incoming: ['<Rung Number="5"/>'] }),
      ],
    });

    render(<Harness onApply={vi.fn()} resolutionData={resolutionData} />);

    expect(classifyRegionMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Next conflict' }));
    expect(classifyRegionMock).toHaveBeenCalledTimes(2);
  });

  it('never validates the composed document in the render path', () => {
    classifyRegionMock.mockReturnValue({
      kind: 'ladder',
      current: { number: 0, raw: 'raw', elements: [], instructions: [] },
      incoming: { number: 0, raw: 'raw', elements: [], instructions: [] },
    });

    render(<Harness onApply={vi.fn()} resolutionData={buildData()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Use Current' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve File' }));

    expect(validateComposedDocumentMock).not.toHaveBeenCalled();
  });

  it('routes non-eligible regions to the text block with line-mode expansion', () => {
    classifyRegionMock.mockReturnValue({ reason: 'incomplete-unit' });
    validateComposedDocumentMock.mockReturnValue({ valid: true });

    render(<Harness onApply={vi.fn()} resolutionData={buildData()} />);

    expect(screen.queryByTestId('rung-preview')).toBeNull();
    expect(screen.getByRole('button', { name: /Choose individual lines/ })).toBeInTheDocument();
  });

  it('surfaces an apply error returned by the service', () => {
    classifyRegionMock.mockReturnValue({
      kind: 'ladder',
      current: { number: 0, raw: 'raw', elements: [], instructions: [] },
      incoming: { number: 0, raw: 'raw', elements: [], instructions: [] },
    });

    render(
      <L5XConflictResolver
        data={buildData()}
        draft={{ path: 'Programs/Main.L5X', resolutionToken: 'token-1', decisions: {} }}
        disabled={false}
        applyError="The resolved file is not a well-formed L5X document."
        onDecision={vi.fn()}
        onApply={vi.fn()}
        onResolveWholeFile={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/not a well-formed L5X document/);
  });

  it('exposes persistent Keep Current File / Keep Incoming File actions and confirms before discarding drafts', () => {
    classifyRegionMock.mockReturnValue({
      kind: 'ladder',
      current: { number: 0, raw: 'raw', elements: [], instructions: [] },
      incoming: { number: 0, raw: 'raw', elements: [], instructions: [] },
    });
    validateComposedDocumentMock.mockReturnValue({ valid: true });

    const onResolveWholeFile = vi.fn();
    render(<Harness onApply={vi.fn()} onResolveWholeFile={onResolveWholeFile} resolutionData={buildData()} />);

    const keepCurrent = screen.getByRole('button', { name: 'Keep Current File' });
    expect(keepCurrent).toBeInTheDocument();

    fireEvent.click(keepCurrent);
    expect(onResolveWholeFile).toHaveBeenCalledWith('mine');

    onResolveWholeFile.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Use Current' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep Incoming File' }));

    expect(onResolveWholeFile).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Replace file' });
    fireEvent.click(confirm);
    expect(onResolveWholeFile).toHaveBeenCalledWith('theirs');
  });
});
