import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInlineDiffModel,
  diffControllers,
  measureRoutineDiffRowHeight,
  type Instruction,
  type NormalizedController,
  type NormalizedProgram,
  type NormalizedRoutine,
  type NormalizedRung,
} from 'ladder-visualizer';

import { buildL5XDiffLayoutViewModel, buildRoutineSemanticId, buildTabId } from './adapter';
import { RoutineDiffInspector } from './RoutineDiffInspector';
import type { L5XDiffRoutineEntity } from './types';
import { controller, routineXml } from './routine-fixtures.test-support';

const useVirtualizerMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: useVirtualizerMock,
}));

function instruction(mnemonic: string, category: Instruction['category'], operands: string[]): Instruction {
  return {
    mnemonic,
    category,
    operands,
  };
}

function makeController(overrides: Partial<NormalizedController> = {}): NormalizedController {
  return {
    name: 'Controller',
    dataTypes: [],
    tags: [],
    programs: [],
    aois: [],
    modules: [],
    tasks: [],
    trends: [],
    quickWatchLists: [],
    ...overrides,
  };
}

function makeProgram(name: string, overrides: Partial<NormalizedProgram> = {}): NormalizedProgram {
  return {
    name,
    tags: [],
    localTags: [],
    routines: [],
    parameters: [],
    ...overrides,
  };
}

function makeRoutine(name: string, rungs: NormalizedRung[], overrides: Partial<NormalizedRoutine> = {}): NormalizedRoutine {
  return {
    name,
    type: 'RLL',
    rungs,
    ...overrides,
  };
}

function makeRung(
  number: number,
  raw: string,
  elements: Instruction[],
  comment?: string,
): NormalizedRung {
  return {
    number,
    raw,
    comment,
    elements,
    instructions: elements,
  };
}

function getRoutineEntity(
  oldController: NormalizedController,
  newController: NormalizedController,
  programName: string,
  routineName: string,
): L5XDiffRoutineEntity {
  const diff = diffControllers(oldController, newController);
  const model = buildL5XDiffLayoutViewModel({ oldController, newController, diff });
  const tabId = buildTabId(buildRoutineSemanticId(programName, routineName));
  const entity = model.entitiesByTabId[tabId];

  if (!entity || entity.kind !== 'routine') {
    throw new Error('Routine entity not found');
  }

  return entity;
}

describe('RoutineDiffInspector', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    };

    useVirtualizerMock.mockReset();
    useVirtualizerMock.mockImplementation(({
      count,
      estimateSize,
    }: {
      count: number;
      estimateSize: (index: number) => number;
    }) => {
      const sizes = Array.from({ length: count }, (_, index) => estimateSize(index));

      return {
        getTotalSize: () => sizes.reduce((total, size) => total + size, 0),
        getVirtualItems: () => sizes.map((size, index) => ({
          key: index,
          index,
          start: sizes.slice(0, index).reduce((total, value) => total + value, 0),
          end: sizes.slice(0, index + 1).reduce((total, value) => total + value, 0),
          size,
          lane: 0,
        })),
        measureElement: () => undefined,
      };
    });
  });

  it.each([0, 1, 2])('renders the deleted rung at %i after following rungs are renumbered', (deletedIndex) => {
    const oldRungs = [0, 1, 2].map(number => makeRung(
      number,
      `XIC(Input${number})OTE(Output${number});`,
      [instruction('XIC', 'input', [`Input${number}`]), instruction('OTE', 'output', [`Output${number}`])],
    ));
    const newRungs = oldRungs.filter((_, index) => index !== deletedIndex)
      .map((rung, number) => ({ ...rung, number }));
    const oldController = makeController({ programs: [makeProgram('Main', {
      routines: [makeRoutine('Motor', oldRungs)],
    })] });
    const newController = makeController({ programs: [makeProgram('Main', {
      routines: [makeRoutine('Motor', newRungs)],
    })] });
    const entity = getRoutineEntity(oldController, newController, 'Main', 'Motor');
    // Content matching reports the original deleted rung, even when its number is reused.
    entity.routineDiff.rungDiffs = [{
      kind: 'removed', rungNumber: deletedIndex, oldRung: oldRungs[deletedIndex], propertyChanges: [],
    }];

    render(<RoutineDiffInspector entity={entity} isDarkMode={false} />);

    expect(screen.getByText(`Rung #${deletedIndex}`)).toBeInTheDocument();
    expect(screen.getByText(`Output${deletedIndex}`)).toBeInTheDocument();
    if (deletedIndex < 2) expect(screen.queryByText(`Output${deletedIndex + 1}`)).not.toBeInTheDocument();
  });

  it('renders modified rungs with the shared inline diff surface instead of split old and new cards', () => {
    const oldController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [
          makeRung(
            0,
            'XIC(Local:1:I.Data.0)MOV(Source_A,DestTag)',
            [
              instruction('XIC', 'input', ['Local:1:I.Data.0']),
              instruction('MOV', 'math', ['Source_A', 'DestTag']),
            ],
            'Original permissive comment',
          ),
        ])],
      })],
    });

    const newController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [
          makeRung(
            0,
            'XIC(Local:2:I.Data.1)MOV(Source_B,DestTag)',
            [
              instruction('XIC', 'input', ['Local:2:I.Data.1']),
              instruction('MOV', 'math', ['Source_B', 'DestTag']),
            ],
            'Updated permissive comment for operators',
          ),
        ])],
      })],
    });

    const entity = getRoutineEntity(oldController, newController, 'Main', 'Motor');
    const { container } = render(<RoutineDiffInspector entity={entity} isDarkMode={false} />);

    expect(container.querySelector('[data-inline-diff-rung="0"]')).not.toBeNull();
    expect(container.querySelector('[data-inline-diff-native-text="label"]')).not.toBeNull();
    expect(container.querySelector('[data-inline-diff-native-text="operand"]')).not.toBeNull();
    expect(container.querySelector('[data-inline-diff-native-text="comment"]')).not.toBeNull();
    expect(container.querySelector('[data-inline-diff-text-change="comment"]')).toBeNull();
    expect(screen.queryByText('Old')).toBeNull();
    expect(screen.queryByText('New')).toBeNull();
  });

  it('uses library-measured row heights for modified and added routine virtualization', () => {
    const oldModifiedRung = makeRung(
      0,
      'XIC(Local:1:I.Data.0)OTE(RunCmd)',
      [
        instruction('XIC', 'input', ['Local:1:I.Data.0']),
        instruction('OTE', 'output', ['RunCmd']),
      ],
      'Original comment',
    );
    const newModifiedRung = makeRung(
      0,
      'XIC(Local:2:I.Data.1)OTE(RunCmd)',
      [
        instruction('XIC', 'input', ['Local:2:I.Data.1']),
        instruction('OTE', 'output', ['RunCmd']),
      ],
      'Updated operator-facing comment',
    );
    const addedRung = makeRung(
      1,
      'XIC(RunCmd)OTE(AlarmHorn)',
      [
        instruction('XIC', 'input', ['RunCmd']),
        instruction('OTE', 'output', ['AlarmHorn']),
      ],
    );

    const oldController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [oldModifiedRung])],
      })],
    });
    const newController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [newModifiedRung, addedRung])],
      })],
    });

    const entity = getRoutineEntity(oldController, newController, 'Main', 'Motor');
    render(<RoutineDiffInspector entity={entity} isDarkMode={false} />);

    const virtualizerOptions = useVirtualizerMock.mock.calls[0]?.[0] as
      | { estimateSize: (index: number) => number }
      | undefined;

    expect(virtualizerOptions).toBeDefined();
    expect(virtualizerOptions?.estimateSize(0)).toBe(
      measureRoutineDiffRowHeight({
        state: 'modified',
        inlineDiffModel: buildInlineDiffModel({
          oldRung: oldModifiedRung,
          newRung: newModifiedRung,
          rungNumber: 0,
        }),
      }),
    );
    expect(virtualizerOptions?.estimateSize(1)).toBe(
      measureRoutineDiffRowHeight({
        state: 'added',
        rung: addedRung,
      }),
    );
  });

  it('renders measured routine rows with the data-index attribute required by TanStack dynamic measurement', () => {
    const oldController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [
          makeRung(
            0,
            'XIC(StartPermissive)OTE(RunCmd)',
            [
              instruction('XIC', 'input', ['StartPermissive']),
              instruction('OTE', 'output', ['RunCmd']),
            ],
          ),
        ])],
      })],
    });

    const newController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [
          makeRung(
            0,
            'XIC(UpdatedStartPermissive)OTE(RunCmd)',
            [
              instruction('XIC', 'input', ['UpdatedStartPermissive']),
              instruction('OTE', 'output', ['RunCmd']),
            ],
          ),
          makeRung(
            1,
            'XIC(RunCmd)OTE(AlarmHorn)',
            [
              instruction('XIC', 'input', ['RunCmd']),
              instruction('OTE', 'output', ['AlarmHorn']),
            ],
          ),
        ])],
      })],
    });

    const entity = getRoutineEntity(oldController, newController, 'Main', 'Motor');
    const { container } = render(<RoutineDiffInspector entity={entity} isDarkMode={false} />);

    expect(container.querySelector('[data-index="0"]')).not.toBeNull();
    expect(container.querySelector('[data-index="1"]')).not.toBeNull();
  });

  it('passes container width to modified inline diff rungs so they can fill available space', async () => {
    const clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);

    globalThis.ResizeObserver = class ResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe() {
        this.callback([], this);
      }

      unobserve() {}
      disconnect() {}
    };

    const oldController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [
          makeRung(
            0,
            'XIC(StartPermissive)OTE(RunCmd)',
            [
              instruction('XIC', 'input', ['StartPermissive']),
              instruction('OTE', 'output', ['RunCmd']),
            ],
          ),
        ])],
      })],
    });

    const newController = makeController({
      programs: [makeProgram('Main', {
        routines: [makeRoutine('Motor', [
          makeRung(
            0,
            'XIC(UpdatedStartPermissive)OTE(RunCmd)',
            [
              instruction('XIC', 'input', ['UpdatedStartPermissive']),
              instruction('OTE', 'output', ['RunCmd']),
            ],
          ),
        ])],
      })],
    });

    const entity = getRoutineEntity(oldController, newController, 'Main', 'Motor');
    const { container } = render(<RoutineDiffInspector entity={entity} isDarkMode={false} />);

    await waitFor(() => {
      expect(container.querySelector('[data-inline-diff-rung="0"]')?.getAttribute('width')).toBe('640');
    });

    clientWidthSpy.mockRestore();
  });
  it('preserves shared inline diff behavior for AOI-owned RLL routines', () => {
    const oldController = controller('aoi', routineXml('RLL'));
    const newController = controller('aoi', routineXml('RLL', 'new'));
    const model = buildL5XDiffLayoutViewModel({ oldController, newController, diff: diffControllers(oldController, newController) });
    const entity = Object.values(model.entitiesByTabId)[0] as L5XDiffRoutineEntity;
    const view = render(<RoutineDiffInspector entity={entity} isDarkMode={false} />);
    expect(view.container.querySelector('[data-inline-diff-rung="0"]')).not.toBeNull();
    expect(screen.getByText('AOI Shared / Logic')).toBeInTheDocument();
    expect(screen.getByText('oldOutput')).toBeInTheDocument();
    expect(screen.getByText('newOutput')).toBeInTheDocument();
  });

  it.each(['program', 'aoi'] as const)('renders each %s RLL source with its own AOI parameter labels when definitions change', ownerKind => {
    const oldAOI = controller('aoi', '').aois[0];
    oldAOI.parameters = [{ name: 'OldParameter', tagType: 'Base', dataType: 'DINT', usage: 'Input',
      required: true, visible: true, externalAccess: 'ReadWrite' }];
    const newAOI = structuredClone(oldAOI);
    newAOI.parameters[0].name = 'NewParameter';
    const oldRoutine = makeRoutine('Logic', [makeRung(0, 'Shared(Instance,OldValue)', [instruction('Shared', 'aoi', ['Instance', 'OldValue'])])]);
    const newRoutine = makeRoutine('Logic', [makeRung(0, 'Shared(Instance,NewValue)', [instruction('Shared', 'aoi', ['Instance', 'NewValue'])])]);
    if (ownerKind === 'aoi') { oldAOI.routines = [oldRoutine]; newAOI.routines = [newRoutine]; }
    const oldController = makeController({ aois: [oldAOI], programs: ownerKind === 'program' ? [makeProgram('Shared', { routines: [oldRoutine] })] : [] });
    const newController = makeController({ aois: [newAOI], programs: ownerKind === 'program' ? [makeProgram('Shared', { routines: [newRoutine] })] : [] });
    const model = buildL5XDiffLayoutViewModel({ oldController, newController, diff: diffControllers(oldController, newController) });
    const entity = Object.values(model.entitiesByTabId)[0] as L5XDiffRoutineEntity;
    const view = render(<RoutineDiffInspector entity={entity} isDarkMode={false} />);
    expect(view.container.querySelector('[data-inline-diff-rung="0"]')).toBeNull();
    expect(screen.getByText('Previous version')).toBeInTheDocument();
    expect(screen.getByText('Current version')).toBeInTheDocument();
    expect(screen.getByText('OldParameter')).toBeInTheDocument();
    expect(screen.getByText('NewParameter')).toBeInTheDocument();
  });

});
