import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ConflictRegion, ConflictResolutionData, TextConflictDraft } from '../../types';
import L5XConflictResolver from './L5XConflictResolver';

vi.mock('ladder-visualizer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ladder-visualizer')>();

  return {
    ...actual,
    VirtualizedLadderDiagram: ({ rungs }: { rungs: Array<{ raw: string }> }) => (
      <div data-testid="real-adapter-rung-preview">{rungs[0]?.raw}</div>
    ),
  };
});

vi.mock('../../../../viewers/components/file/l5x/theme', () => ({
  IOFABRIK_LADDER_THEME: {},
}));

vi.mock('../../../../context/LayoutContext', () => ({
  useLayout: () => ({ theme: 'light' }),
}));

function region(partial: Partial<ConflictRegion>): ConflictRegion {
  return {
    id: 'region-1',
    current: [],
    base: [],
    incoming: [],
    contextBefore: '',
    contextAfter: '',
    ...partial,
  };
}

function renderResolver(conflictRegion: ConflictRegion): void {
  const data: ConflictResolutionData = {
    success: true,
    path: 'Programs/Main.L5X',
    status: 'both-modified',
    eligible: true,
    base: { present: true },
    current: { present: true },
    incoming: { present: true },
    regions: [conflictRegion],
    resolutionToken: 'token-1',
    newline: '\n',
    hasFinalNewline: true,
  };
  const draft: TextConflictDraft = {
    path: data.path,
    resolutionToken: data.resolutionToken || '',
    decisions: { [conflictRegion.id]: { mode: 'unresolved' } },
  };

  render(
    <L5XConflictResolver
      data={data}
      draft={draft}
      disabled={false}
      onDecision={vi.fn()}
      onApply={vi.fn()}
      onResolveWholeFile={vi.fn()}
    />,
  );
}

describe('L5XConflictResolver with the real visual adapter', () => {
  it('renders ladder previews when bare rung CDATA can be expanded from context', () => {
    renderResolver(region({
      current: ['<![CDATA[NOP();]]>'],
      incoming: ['<![CDATA[XIC(Start)OTE(Motor);]]>'],
      contextBefore: '<Rung Number="7" Type="N">\n<Text>\n',
      contextAfter: '</Text>\n</Rung>\n',
    }));

    expect(screen.getAllByTestId('real-adapter-rung-preview')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Choose individual lines/ })).toBeNull();
  });

  it('routes bare description CDATA to the text resolver', () => {
    renderResolver(region({
      current: ['<![CDATA[Pump description]]>'],
      incoming: ['<![CDATA[Updated pump description]]>'],
      contextBefore: '<DataType Name="Pump"><Members><Member Name="State"><Description>\n',
      contextAfter: '</Description></Member></Members></DataType>\n',
    }));

    expect(screen.queryByTestId('real-adapter-rung-preview')).toBeNull();
    expect(screen.getByRole('button', { name: /Choose individual lines/ })).toBeInTheDocument();
  });

  it('routes bare CDATA with truncated context to the text resolver', () => {
    renderResolver(region({
      current: ['<![CDATA[NOP();]]>'],
      incoming: ['<![CDATA[OTE(Motor);]]>'],
      contextBefore: '<Rung Number="8" Type="N">\n<Text>\n',
      contextAfter: '</Text>\n',
    }));

    expect(screen.queryByTestId('real-adapter-rung-preview')).toBeNull();
    expect(screen.getByRole('button', { name: /Choose individual lines/ })).toBeInTheDocument();
  });

  it.each([
    [
      'Text',
      '<Text><![CDATA[XIC(Start)OTE(Motor);]]></Text>',
      '<Text><![CDATA[XIC(Ready)OTE(Motor);]]></Text>',
    ],
    [
      'Comment',
      '<Comment><![CDATA[Current comment]]></Comment>',
      '<Comment><![CDATA[Incoming comment]]></Comment>',
    ],
  ])('keeps explicit %s fragments in the visual resolver', (_element, current, incoming) => {
    renderResolver(region({ current: [current], incoming: [incoming] }));

    expect(screen.getAllByTestId('real-adapter-rung-preview')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Choose individual lines/ })).toBeNull();
  });
});
